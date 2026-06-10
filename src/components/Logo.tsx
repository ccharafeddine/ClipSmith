/**
 * ClipSmith wordmark in Syne: two-tone weight (bold "Clip" with the signature
 * gradient, lighter "Smith" in the secondary cyan), framed by the iOS-style
 * timeline trim selection (violet grab-handles + rails). Mirrors GifSmith's
 * wordmark so the two apps read as siblings.
 */
export default function Logo() {
  return (
    <div class="logo" role="img" aria-label="ClipSmith">
      <span class="logo-frame">
        <span class="logo-handle logo-handle-l" />
        <span class="logo-word">
          <span class="logo-clip">Clip</span>
          <span class="logo-smith">Smith</span>
        </span>
        <span class="logo-handle logo-handle-r" />
      </span>
    </div>
  );
}
