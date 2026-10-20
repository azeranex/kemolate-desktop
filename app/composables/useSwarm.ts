/**
 * The swarm — a stand-in, because the desktop app shares nothing peer to peer.
 *
 * In the web build this is the WebRTC side of sharing a workspace. The one
 * thing the migrated files ask of it is `peerHeader`, which marks a request to
 * the server as coming from this tab's peer so the server does not echo it
 * back; with no socket for the workspace the web build answers `{}`, and so
 * does this, always.
 */
export function peerHeader (_workspace: string): Record<string, string> {
  return {}
}
