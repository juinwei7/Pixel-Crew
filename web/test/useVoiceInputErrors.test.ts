import assert from "node:assert/strict";
import test from "node:test";
import { microphoneErrorMessage } from "../src/hooks/useVoiceInput";

test("microphone failures explain the actionable Windows cause", () => {
  assert.match(microphoneErrorMessage({ name: "NotAllowedError" }), /隱私權設定/);
  assert.match(microphoneErrorMessage({ name: "NotFoundError" }), /可用的麥克風/);
  assert.match(microphoneErrorMessage({ name: "NotReadableError" }), /其他程式/);
});
