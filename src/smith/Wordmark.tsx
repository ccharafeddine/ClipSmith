import mark from "./mark.svg";

/** Smith v2 wordmark: the family mark (violet frame, cyan spark, clip glyph)
 *  plus "Clip" in the app hue and "Smith" in text colour. See docs/design-system.md in MediaSmith. */
export default function Wordmark() {
  return (
    <span class="sm-wordmark" role="img" aria-label="ClipSmith">
      <img src={mark} alt="" width="26" height="26" />
      <span aria-hidden="true"><span class="wm-app">Clip</span><span class="wm-smith">Smith</span></span>
    </span>
  );
}
