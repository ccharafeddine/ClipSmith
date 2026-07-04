//! Subject detection for auto-reframe (v2 Tier 2).
//!
//! Pure-Rust ONNX inference via `tract` (no native ONNX Runtime lib to bundle).
//! Two bundled detectors: a face detector (Ultraface, MIT) and a person detector
//! (NanoDet-Plus, Apache-2.0). Both are *raw-output* models — they emit boxes +
//! scores and we do score-thresholding / NMS in Rust — which keeps the ONNX
//! graphs op-simple (conv/relu/reshape), the exact thing that must load cleanly
//! in tract. Models ship as read-only Tauri resources (see `scripts/fetch-models`).
//!
//! ## M0 status
//!
//! This module currently holds only the runtime spike: it proves `tract`
//! compiles into the build and that both bundled models *load, optimize, and run*
//! (the op-coverage risk that gated the person-model choice). The real analyze
//! pipeline (frame decode → detect → track → path) lands in later milestones.

/// The bundled models directory. During development / the spike this is the
/// project's `src-tauri/models` (baked in via `CARGO_MANIFEST_DIR`); the shipped
/// app will resolve them from the Tauri resource dir instead.
#[cfg(test)]
fn models_dir() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("models")
}

#[cfg(test)]
mod spike {
    use super::models_dir;
    use tract_onnx::prelude::*;

    /// Load an ONNX model with a fixed input shape, optimize it, make it runnable,
    /// and run a single zeroed input through it. Returns the output tensor shapes.
    /// This is the whole op-coverage question: if tract can optimize + run the
    /// graph, the model is usable; the actual detections don't matter here.
    fn load_and_run(file: &str, shape: [usize; 4]) -> TractResult<Vec<Vec<usize>>> {
        let path = models_dir().join(file);
        let model = tract_onnx::onnx()
            .model_for_path(&path)?
            .with_input_fact(0, f32::fact(shape).into())?
            .into_optimized()?
            .into_runnable()?;

        let input = Tensor::zero::<f32>(&shape)?;
        let outputs = model.run(tvec!(input.into()))?;
        Ok(outputs
            .iter()
            .map(|o| o.shape().to_vec())
            .collect::<Vec<_>>())
    }

    /// Skip (don't fail) when the model file isn't present — the CI check job
    /// doesn't fetch the models. Returns true if the file is available.
    fn available(file: &str) -> bool {
        let there = models_dir().join(file).exists();
        if !there {
            eprintln!("skipping tract spike: {file} not present (run scripts/fetch-models.sh)");
        }
        there
    }

    #[test]
    fn ultraface_loads_and_runs_in_tract() {
        if !available("ultraface-320.onnx") {
            return;
        }
        // Ultraface RFB-320: NCHW, 240x320, RGB. Two outputs: scores [1,N,2] and
        // boxes [1,N,4].
        let shapes = load_and_run("ultraface-320.onnx", [1, 3, 240, 320])
            .expect("ultraface should load, optimize, and run in tract");
        assert!(!shapes.is_empty(), "ultraface produced no outputs");
        eprintln!("ultraface output shapes: {shapes:?}");
    }

    #[test]
    fn nanodet_loads_and_runs_in_tract() {
        if !available("nanodet-plus-m-416.onnx") {
            return;
        }
        // NanoDet-Plus-m: NCHW, 416x416. Single concatenated raw-prediction output.
        let shapes = load_and_run("nanodet-plus-m-416.onnx", [1, 3, 416, 416])
            .expect("nanodet should load, optimize, and run in tract");
        assert!(!shapes.is_empty(), "nanodet produced no outputs");
        eprintln!("nanodet output shapes: {shapes:?}");
    }
}
