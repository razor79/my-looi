// Managed keywords for the shared Sherpa KWS stream. STOP is deliberately
// much more sensitive than the wake name because it is a physical safety command.
// Multiple STOP/СТОП/СТОЙ-like pronunciations give the local fast lane several
// chances to fire before offline ASR completes.
export const KWS_KEYWORDS = [
  "L UW0 IY1 :2.4 #0.20 @LOOI",
  "L UW0 Y IY1 :2.2 #0.20 @LOOI_PALATALIZED",
  "S T AA1 P :4.5 #0.08 @STOP",
  "S T AO1 P :4.5 #0.08 @STOP",
  "S T AH1 P :4.3 #0.09 @STOP",
  "S T EH1 P :4.0 #0.10 @STOP",
  "S T OY1 :3.8 #0.10 @STOP",
  "",
].join("\n");
