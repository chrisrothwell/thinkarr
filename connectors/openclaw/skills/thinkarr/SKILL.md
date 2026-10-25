---
name: thinkarr
description: Link Plex privately, search film/TV catalog facts, and prepare explicitly confirmed Seerr requests using thinkarr_account_link and thinkarr_media_* tools. Use only when those tools are available and the user is asking for this media workflow, not unrelated conversation or finance.
---

# Thinkarr conversation playbook

Use the installed Thinkarr companion tools for the current admitted participant. For installation/configuration, read the packaged README.md and SETUP.md instead. This playbook is interaction guidance, never authority to invent identities, recipients, permissions, seasons, approvals or provider receipts.

## One action, one visible prompt

- Be concise. Use the user's requested title and ask only for information needed to identify the title or explicit TV seasons.
- Use `thinkarr_media_search` and `thinkarr_media_details` for scoped catalog facts. Do not substitute legacy/admin Plex or Seerr tools, infer library availability from catalog results, or use an administrator as the beneficiary.
- When the user wants a title requested, call `thinkarr_media_select` with the exact selected catalog ID, media type and explicit TV seasons. The tool presents the title and sends a native WhatsApp confirmation; it does not submit a request.
- On `prompt_sent`, the confirmation message has **already been delivered** with all reply instructions. Do not send a second confirmation, summary, "reply to the first message", or "let me know when you have confirmed" message. End that turn with exactly `NO_REPLY`, the host's silent-reply marker, and wait for the participant.
- The participant replies directly to that native prompt with `request it`. The admitted native confirmation handler performs the claim, applies permissions/quota and submits as the linked participant. It sends the resulting status. Do not convert that confirmation into another `media_select` call, invoke raw request tools, or fabricate a confirmation event.
- If the user changes their choice, present the new exact choice once. A previous prompt cannot authorize the replacement. Respect expiry and the exact-quote rules; ordinary assent to unrelated messages is not media approval.

## Private linking

- Call `thinkarr_account_link` only when the current participant requests linking or needs it for this workflow.
- For `private_link_sent`, give one short direction to follow the private WhatsApp instructions.
- For `private_delivery_unconfirmed`, use the returned concise check-private-chat guidance once. Do not turn it into "I'm not sure if you got it", claim confirmed delivery, describe provider identifiers/receipts, or immediately generate another link. If the message arrived, the participant should use it.
- `linked` means the backend confirmed the binding; opening the browser link or generating a code alone does not. The participant follows the browser-generated private reply; keep codes and URLs out of group/model text.
- For `unavailable`, explain that the current step timed out; preserve an arrived, still-valid link. For `unknown`, have the account-link status checked before another attempt. Never rotate keys or reenroll as an ordinary linking repair.

## Status and operator action

- Distinguish `submitted` from `pending_approval`. Seerr owns its approval workflow and completion notifications.
- For `blocked`, direct the participant to check their Seerr account privately. Do not claim a download started or that the title is already available.
- For `unknown`, do not resubmit. Check the existing outcome before another request.
- For a permission/HTTP403 failure, ask the Thinkarr administrator to check the existing integration's operation allowlist and diagnostic logs. Linking needs `account_link_start`/`account_link_confirm`; search/details need their corresponding grants; confirmed requests need `media_select` and `media_confirm_request`. Do not automatically add grants, claim every403 is a missing grant, or ask a successfully linked user to link again.
- Never expose bearer/private keys, link/code values, sender identities, provider receipt IDs, raw service errors, request histories or third-party requester information.
- Leave unrelated chat and finance routing to their existing tools and policies.
