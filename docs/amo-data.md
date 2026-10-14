# What foxmate sends, and its AMO data declaration

The manifest declares `data_collection_permissions` with `"required": ["none"]`
and four optional types. Firefox asks for an optional type at the click that
turns its feature on. This page lists what leaves the browser, and the type
that covers it.

The planner always runs on this computer or in Firefox, so the goal and page
text never go to a model provider through foxmate. Saved logins stay in a
foxvault in this Firefox profile. A fill writes a password into a page after
you approve it, which is the sign-in you asked for, not a transmission by
foxmate.

| What | To whom | When | AMO data type |
|---|---|---|---|
| Page text of one shared tab | Claude Code, through the foxbridge host | Only while you share the tab | `websiteContent` (optional) |
| Mail and calendar requests, with Google tokens | Google's API | Only after you connect Google with your own OAuth client id | `personalCommunications`, `authenticationInfo` (optional) |
| Approvals | Your paired phone, over an encrypted WebRTC link | Only after you pair a phone | None: the link ends at your own device |
| The sealed pairing offer (the WebRTC setup, which holds your local IP addresses) and the phone's sealed answer | The foxsync relay, `foxsync-relay.hello-fd1.workers.dev`, which keeps each text for at most 10 minutes | Only while you pair a phone | None: the text is sealed with the pairing code, which never goes to the relay. The relay sees the public IP address of this computer and of the phone, the time, and the size of each text |
| The webhook notice: the kind, the priority, a fixed sentence that foxmate writes, and the time | The webhook address that you type, for example your own ntfy topic | Only after you tick "Send notices to this webhook". Off by default | None: foxmate writes all of this text |
| The goal, as the title of a webhook notice | The same address | Only after you also tick "Put the goal in the webhook notice" | `websiteActivity` (optional) |
| Model files | Hugging Face | At the first use of an in-browser model | None: the request holds no user data |

## Why the webhook title is `websiteActivity`

foxnotify's failure mode DC1 says that a real agent which sends titles made
from goals or pages must declare it. A foxmate goal names what you do on a
site, for example "Pay the bill on example-bank.com". So the title box asks
Firefox for `websiteActivity` consent. The background page checks the
consent again before each send. Without it, the webhook gets no title, also
when the box is set.

Desktop notices stay on this computer. Firefox shows them, and they are not
a transmission.

## When this changes

A new feature that sends data out of the browser updates the manifest, this
page, and the listing in `extension/amo-metadata.json` in the same change.
