# ClipSmith — lessons

Newest on top. Each entry = a mistake/finding and the rule that prevents it.

## ONNX score decode: check if the model already applies the activation
When detection confidences look *compressed* or wrong (here: every score in
[0.50, 0.69], empty priors at exactly 0.50 = `sigmoid(0)`), suspect a **double
activation**. NanoDet's ONNX graph already ends in `Sigmoid` on the class scores,
but `decode_nanodet` applied `sigmoid()` again, squashing everything and creating
a ~693-box/frame noise floor.
**Rule:** before applying sigmoid/softmax to a model output in code, trace the
ONNX graph's output node (`onnx.load` + walk producers) to see if it's already
there. Compressed scores with a floor at exactly 0.5 is the tell.

## Offline path smoothing must be zero-phase, not causal
A one-pass EMA only ever *trails* its input. At 3 fps a smoothing factor low
enough to be steady lagged the crop ~2s behind the subject ("follows behind").
Path building is offline (whole sequence known), so use a **forward-backward
(zero-phase) filter** — the two passes' lags cancel. Amplitude attenuation on
fast moves still reads as lag; raise the factor for responsiveness.

## Tune detection/tracking heuristics against a real dump, not by guessing
Guessing at "is it faces-on-pineapples or persons-on-pineapples" wasted time.
Dumping the analyze detections to JSON and analyzing offline (score distribution,
per-frame boxes at the failure timestamps, simulating the path pipeline in a
throwaway node script) pinpointed each cause and let me validate fixes *before*
recompiling. Invert transforms to recover pre-fix values (`logit(s)` recovered
true scores from the double-sigmoid dump) so you can test a fix without a rebuild.

## Silhouette/stylized subjects are near worst-case for COCO person detectors
A flat black cartoon hero scores 0.2–0.4 while faced-pineapple decoys score
comparably. No path-building heuristic fixes a subject the detector can't see.
The general answer was a **manual override** (drag-to-fix), not more tuning.
