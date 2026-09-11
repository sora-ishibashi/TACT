// OAuth return URL handling stays browser-API free so its trust-boundary
// behavior can be tested without mounting a React component.

export function readOAuthReturnConnectionId(search: string): string | null {
  const connectionId = new URLSearchParams(search).get("connectionId")?.trim();

  return connectionId ? connectionId : null;
}

export function removeOAuthReturnConnectionId(urlString: string): string {
  const url = new URL(urlString);

  url.searchParams.delete("connectionId");

  return url.toString();
}

export function buildConnectionConfirmEndpoint(connectionId: string): string {
  return `/api/tact/connections/${encodeURIComponent(connectionId)}/confirm`;
}
