import * as AuthSession from 'expo-auth-session';
import * as WebBrowser from 'expo-web-browser';
import type { McpOAuthConfig, McpServerConfig } from '../types';
import { clearOAuthTokens, loadOAuthTokens, saveOAuthTokens } from './storage';

// Required once so a browser-based auth session resolves its pending promise
// when control returns to the app. No-op on native, matters on web.
WebBrowser.maybeCompleteAuthSession();

export interface OAuthStatus {
  connected: boolean;
  expiresAt?: number;
}

/** Extract scheme://host[:port] from a URL, dropping any path/query/fragment. */
export function deriveBaseUrl(url: string): string {
  const match = url.trim().match(/^([a-zA-Z][a-zA-Z\d+.-]*:\/\/[^/?#]+)/);
  return match ? match[1] : '';
}

function toDiscovery(oauth: McpOAuthConfig) {
  return {
    authorizationEndpoint: oauth.authorizationEndpoint,
    tokenEndpoint: oauth.tokenEndpoint,
  };
}

function requireOAuthConfig(server: McpServerConfig): McpOAuthConfig {
  const oauth = server.oauth;
  if (!oauth?.authorizationEndpoint || !oauth.tokenEndpoint || !oauth.clientId) {
    throw new Error('Set the authorization URL, token URL, and client ID before connecting.');
  }
  return oauth;
}

/**
 * Run the interactive OAuth Authorization Code + PKCE flow in the system
 * browser and persist the resulting tokens to SecureStore. Throws on
 * cancellation or failure — callers should surface the error message.
 */
export async function connectMcpServer(server: McpServerConfig): Promise<void> {
  const oauth = requireOAuthConfig(server);
  const discovery = toDiscovery(oauth);
  const redirectUri = AuthSession.makeRedirectUri();

  const request = new AuthSession.AuthRequest({
    clientId: oauth.clientId,
    clientSecret: oauth.clientSecret || undefined,
    scopes: oauth.scopes.length > 0 ? oauth.scopes : undefined,
    redirectUri,
    responseType: AuthSession.ResponseType.Code,
    usePKCE: true,
  });

  const result = await request.promptAsync(discovery);

  if (result.type === 'cancel' || result.type === 'dismiss') {
    throw new Error('Sign-in was cancelled.');
  }
  if (result.type !== 'success') {
    throw new Error(`Sign-in failed (${result.type}).`);
  }
  if (result.error) {
    throw new Error(result.error.message || 'Authorization server returned an error.');
  }
  if (!result.params.code) {
    throw new Error('Authorization server did not return a code.');
  }

  const tokenResponse = await AuthSession.exchangeCodeAsync(
    {
      clientId: oauth.clientId,
      clientSecret: oauth.clientSecret || undefined,
      code: result.params.code,
      redirectUri,
      extraParams: request.codeVerifier ? { code_verifier: request.codeVerifier } : undefined,
    },
    discovery,
  );

  await saveOAuthTokens(server.id, {
    accessToken: tokenResponse.accessToken,
    refreshToken: tokenResponse.refreshToken,
    expiresAt: tokenResponse.expiresIn
      ? (tokenResponse.issuedAt + tokenResponse.expiresIn) * 1000
      : undefined,
    tokenType: tokenResponse.tokenType,
    scope: tokenResponse.scope,
  });
}

export async function disconnectMcpServer(serverId: string): Promise<void> {
  await clearOAuthTokens(serverId);
}

export async function getOAuthStatus(serverId: string): Promise<OAuthStatus> {
  const tokens = await loadOAuthTokens(serverId);
  if (!tokens) return { connected: false };
  return { connected: true, expiresAt: tokens.expiresAt };
}

/**
 * Return a currently-valid access token for the server, refreshing via the
 * stored refresh token if the access token is expired or expiring soon.
 * Returns null if the server has never been connected, or refresh fails
 * (e.g. the refresh token was revoked) — callers should treat that as
 * "not connected" rather than retrying indefinitely.
 */
export async function getValidAccessToken(server: McpServerConfig): Promise<string | null> {
  const oauth = server.oauth;
  if (!oauth) return null;

  const tokens = await loadOAuthTokens(server.id);
  if (!tokens) return null;

  const isFresh = !tokens.expiresAt || tokens.expiresAt - Date.now() > 60_000;
  if (isFresh) return tokens.accessToken;

  if (!tokens.refreshToken) {
    return null;
  }

  try {
    const refreshed = await AuthSession.refreshAsync(
      {
        clientId: oauth.clientId,
        clientSecret: oauth.clientSecret || undefined,
        refreshToken: tokens.refreshToken,
      },
      toDiscovery(oauth),
    );

    await saveOAuthTokens(server.id, {
      accessToken: refreshed.accessToken,
      refreshToken: refreshed.refreshToken ?? tokens.refreshToken,
      expiresAt: refreshed.expiresIn ? (refreshed.issuedAt + refreshed.expiresIn) * 1000 : undefined,
      tokenType: refreshed.tokenType,
      scope: refreshed.scope,
    });
    return refreshed.accessToken;
  } catch {
    return null;
  }
}
