/**
 * Auth Providers Registry — all supported service integrations.
 *
 * Each provider defines:
 * - How to authenticate (OAuth flow type, URLs, scopes)
 * - How to validate a token
 * - What the service is used for in LGTM
 *
 * Supports: GitHub, Claude, OpenAI, GitLab, Bitbucket, Linear, Slack, ClickUp, Google
 */

export interface AuthProvider {
  /** Unique service identifier */
  id: string;

  /** Display name */
  name: string;

  /** What this service is used for in LGTM */
  purpose: string;

  /** OAuth flow type */
  flow: "device" | "pkce" | "api-key";

  /** OAuth configuration */
  oauth?: {
    authorizeUrl: string;
    tokenUrl: string;
    defaultScopes: string;
    clientIdEnvVar: string;
  };

  /** Environment variable for API key fallback */
  envVar: string;

  /** URL to get an API key manually */
  keyUrl: string;

  /** How to validate the token */
  validateUrl?: string;

  /** Extract username from validation response */
  extractUser?: (data: any) => string;
}

/**
 * All supported auth providers.
 */
export const AUTH_PROVIDERS: Record<string, AuthProvider> = {
  github: {
    id: "github",
    name: "GitHub",
    purpose: "PR reviews, code hosting, issue tracking",
    flow: "device",
    oauth: {
      authorizeUrl: "https://github.com/login/device/code",
      tokenUrl: "https://github.com/login/oauth/access_token",
      defaultScopes: "repo read:user",
      clientIdEnvVar: "LGTM_GITHUB_CLIENT_ID",
    },
    envVar: "GITHUB_TOKEN",
    keyUrl: "https://github.com/settings/tokens/new",
    validateUrl: "https://api.github.com/user",
    extractUser: (data) => `@${data.login}`,
  },

  claude: {
    id: "claude",
    name: "Claude (Anthropic)",
    purpose: "AI-powered code review, rule enforcement, summaries",
    flow: "pkce",
    oauth: {
      authorizeUrl: "https://claude.ai/oauth/authorize",
      tokenUrl: "https://console.anthropic.com/v1/oauth/token",
      defaultScopes: "api",
      clientIdEnvVar: "LGTM_CLAUDE_CLIENT_ID",
    },
    envVar: "ANTHROPIC_API_KEY",
    keyUrl: "https://console.anthropic.com/settings/keys",
    validateUrl: "https://api.anthropic.com/v1/messages",
    extractUser: () => "Claude API",
  },

  openai: {
    id: "openai",
    name: "OpenAI",
    purpose: "AI-powered code review, rule enforcement, summaries",
    flow: "api-key",
    envVar: "OPENAI_API_KEY",
    keyUrl: "https://platform.openai.com/api-keys",
    validateUrl: "https://api.openai.com/v1/models",
    extractUser: () => "OpenAI API",
  },

  gitlab: {
    id: "gitlab",
    name: "GitLab",
    purpose: "PR/MR reviews, code hosting (alternative to GitHub)",
    flow: "pkce",
    oauth: {
      authorizeUrl: "https://gitlab.com/oauth/authorize",
      tokenUrl: "https://gitlab.com/oauth/token",
      defaultScopes: "api read_user read_repository write_repository",
      clientIdEnvVar: "LGTM_GITLAB_CLIENT_ID",
    },
    envVar: "GITLAB_TOKEN",
    keyUrl: "https://gitlab.com/-/user_settings/personal_access_tokens",
    validateUrl: "https://gitlab.com/api/v4/user",
    extractUser: (data) => `@${data.username}`,
  },

  bitbucket: {
    id: "bitbucket",
    name: "Bitbucket",
    purpose: "PR reviews, code hosting (alternative to GitHub)",
    flow: "pkce",
    oauth: {
      authorizeUrl: "https://bitbucket.org/site/oauth2/authorize",
      tokenUrl: "https://bitbucket.org/site/oauth2/access_token",
      defaultScopes: "repository pullrequest account",
      clientIdEnvVar: "LGTM_BITBUCKET_CLIENT_ID",
    },
    envVar: "BITBUCKET_TOKEN",
    keyUrl: "https://bitbucket.org/account/settings/app-passwords/",
    validateUrl: "https://api.bitbucket.org/2.0/user",
    extractUser: (data) => `@${data.username}`,
  },

  linear: {
    id: "linear",
    name: "Linear",
    purpose: "Issue tracking, task management in dashboard",
    flow: "pkce",
    oauth: {
      authorizeUrl: "https://linear.app/oauth/authorize",
      tokenUrl: "https://api.linear.app/oauth/token",
      defaultScopes: "read write issues:create",
      clientIdEnvVar: "LGTM_LINEAR_CLIENT_ID",
    },
    envVar: "LINEAR_API_KEY",
    keyUrl: "https://linear.app/settings/api",
    validateUrl: "https://api.linear.app/graphql",
    extractUser: () => "Linear",
  },

  slack: {
    id: "slack",
    name: "Slack",
    purpose: "Notifications, review summaries to channels",
    flow: "pkce",
    oauth: {
      authorizeUrl: "https://slack.com/oauth/v2/authorize",
      tokenUrl: "https://slack.com/api/oauth.v2.access",
      defaultScopes: "channels:read chat:write users:read",
      clientIdEnvVar: "LGTM_SLACK_CLIENT_ID",
    },
    envVar: "SLACK_TOKEN",
    keyUrl: "https://api.slack.com/apps",
    validateUrl: "https://slack.com/api/auth.test",
    extractUser: (data) => data.user ?? "Slack",
  },

  clickup: {
    id: "clickup",
    name: "ClickUp",
    purpose: "Task management, link PRs to tasks, dashboard",
    flow: "pkce",
    oauth: {
      authorizeUrl: "https://app.clickup.com/api",
      tokenUrl: "https://api.clickup.com/api/v2/oauth/token",
      defaultScopes: "",
      clientIdEnvVar: "LGTM_CLICKUP_CLIENT_ID",
    },
    envVar: "CLICKUP_TOKEN",
    keyUrl: "https://app.clickup.com/settings/apps",
    validateUrl: "https://api.clickup.com/api/v2/user",
    extractUser: (data) => data.user?.username ?? "ClickUp",
  },

  google: {
    id: "google",
    name: "Google (Gmail + Calendar)",
    purpose: "Email threads, meeting context in dashboard",
    flow: "pkce",
    oauth: {
      authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenUrl: "https://oauth2.googleapis.com/token",
      defaultScopes: "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/calendar.readonly",
      clientIdEnvVar: "LGTM_GOOGLE_CLIENT_ID",
    },
    envVar: "GOOGLE_TOKEN",
    keyUrl: "https://console.cloud.google.com/apis/credentials",
    validateUrl: "https://www.googleapis.com/oauth2/v1/userinfo",
    extractUser: (data) => data.email ?? "Google",
  },
};

/**
 * Get all provider IDs.
 */
export function getProviderIds(): string[] {
  return Object.keys(AUTH_PROVIDERS);
}

/**
 * Get a provider by ID.
 */
export function getProvider(id: string): AuthProvider | undefined {
  return AUTH_PROVIDERS[id];
}
