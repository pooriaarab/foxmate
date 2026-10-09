// A test phone for the E2E test: the phone end of foxsync, with no UI
// beyond what the test drives. window.phone.decision says how to answer.
import { onApprovalRequest, pairPhone } from "foxsync";

window.phone = {
  decision: "approve",
  requests: [],
  async pair(text) {
    const pairing = await pairPhone(text, { name: "Test phone" });
    pairing.waitForDesktop().then((link) => {
      window.phone.paired = true;
      onApprovalRequest(link, (request) => {
        window.phone.requests.push(request);
        return window.phone.decision;
      });
    });
    return pairing.answer;
  },
};
