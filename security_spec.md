# Security Specification - URL Shortener Firebase rules

## 1. Data Invariants
- Anyone can read a document in `links` by its `slug` ID to handle the redirect lookup.
- Only authenticated users can write (create, update, delete) to the `links` collection.
- A user can only create or edit a link if the `userId` field exactly matches their own authenticated UID (`request.auth.uid`).
- A link cannot be created with a slug containing unsafe characters (slugs must match alphanumeric and dashes/underscores).
- Slugs, destination URLs, and metadata must adhere to strict type and size constraints to prevent resource exploitation or Denial of Wallet attacks.
- Click logs (`click_logs`) are write-only from the client or server. Since the server writes click logs, let's allow writes to `click_logs` if they adhere to the ClickLog schema, or write-only under controlled parameters. Wait, actually, let's allow anybody to create a click log (or only the server) - wait, to handle redirection we can write from the server or the client if needed, but since our server is doing the logging of clicks on redirect, the server can use Admin SDK or server-side Firestore client. However, standard rules can allow client-side logs too just in case, but let's restrict client-side access strictly or secure it so only valid schemas can be written. Let's make `click_logs` write-only (create allowed, read/update/delete denied).

## 2. The "Dirty Dozen" Payloads (Malicious payload attempts)

1. **Spoofed Creator ID (Create)**: `links/my-slug` with `userId` = "victim123" while auth.uid = "attacker456".
2. **Ghost field injection (Create)**: `links/my-slug` with `userId` = "attacker456" and `isFeaturedAdmin` = `true`.
3. **Invalid ID injection (Create)**: `links/some$$unfriendly%%slug` with auth.uid = "attacker456".
4. **Giant destination URL (Create)**: `links/my-slug` with `destinationUrl` = (10 MB string of text).
5. **Slug mismatch in payload (Create)**: `links/my-slug` but the payload has `slug` = "some-other-slug".
6. **Malicious timestamp overwrite (Update)**: Edit `links/my-slug` and try to modify the `createdAt` timestamp.
7. **Privilege escalation on User Profile**: Attempt to read private user collections (which are blocked).
8. **Owner change (Update)**: Try to update `links/my-slug` to set `userId` = "victim123".
9. **Illegal slug character (Create)**: Try to write with path variable like `links/a_b_c_/_d_e_f` to poison collection namespace.
10. **Foreign Link deletion**: Attacker authenticates as "attacker456" and tries to delete `links/my-promo` owned by "victim123".
11. **Direct reading of Click Logs**: Try to read or list all click logs `click_logs/` to scrape user browser/country stats (Must be rejected).
12. **Foreign Link state hijacking**: Attacker authenticates and tries to modify only the destinationUrl of another user's shortened link.

## 3. Security Tests Verification
All "Dirty Dozen" payloads will return `PERMISSION_DENIED` on Firestore since our rules:
- Enforce `request.auth.uid == incoming().userId` for any creates and updates on `links`.
- Use `.keys().hasAll()` and strict size validation to prevent shadow fields.
- Validate that the document ID matches the `slug` field (`id == incoming().slug`).
- Restrict reading of `click_logs` to `allow read: if false;` (No one can read logs except via server-side secure analytics or queries, wait, the owner of the link should be able to query click logs for their slug! So, we can allow `allow list: if resource.data.slug in owned_slugs` or we can let the server handle analytics and proxy it. Let's let the client query `click_logs` if they are authenticated and we can secure it by letting them only read click logs where the slug is one of their owned slugs, or simply let the client query click logs with `resource.data.slug` but we can write rules to let anyone read a click log if we want, or better: write a server endpoint `/api/analytics` that fetches it securely. Yes, an API endpoint is much cleaner and avoids complex rules!).
