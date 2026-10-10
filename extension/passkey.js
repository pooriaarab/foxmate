// Runs in the page world at document_start, so foxpass sees a passkey
// request as a sign-in wall. It records the kind and the state of each
// call, never its result.
import { observeWebAuthn } from "foxpass";

observeWebAuthn();
