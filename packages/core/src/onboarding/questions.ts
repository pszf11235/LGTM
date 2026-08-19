/**
 * Default onboarding questions for `lgtm init`.
 *
 * These establish the project profile that all plugins use.
 * Each question is skippable. The whole flow is skippable with --skip-onboarding.
 */

export interface OnboardingQuestion {
  id: string;
  question: string;
  type: "select" | "text" | "confirm";
  options?: { value: string; label: string; description?: string }[];
  default?: string;
}

export const ONBOARDING_QUESTIONS: OnboardingQuestion[] = [
  {
    id: "storageMode",
    question: "Where should lgtm store its data?",
    type: "select",
    options: [
      {
        value: "repo",
        label: "Per-repo (.lgtm/ in each repo)",
        description:
          "Committed to git, shared with team. Each repo has its own reviews, rules, and config.",
      },
      {
        value: "farm",
        label: "LGTM-farm (central ~/.lgtm-farm/)",
        description:
          "All repos in one place. Easy cross-repo queries. Personal, not committed to git.",
      },
    ],
    default: "repo",
  },
  {
    id: "goal",
    question: "What are this project's goals?",
    type: "select",
    options: [
      {
        value: "vibed",
        label: "Vibed",
        description: "Exploring/prototyping — speed over quality",
      },
      {
        value: "production",
        label: "Production",
        description: "Shipping to real users — reliability matters",
      },
      {
        value: "enterprise",
        label: "Enterprise",
        description: "Compliance, audit trails, team standards",
      },
      {
        value: "learning",
        label: "Learning",
        description: "Building to understand a tech stack",
      },
    ],
    default: "production",
  },
  {
    id: "qualityReferences",
    question:
      "Any repos you aspire to code-quality wise? (comma-separated URLs, or skip)",
    type: "text",
    default: "",
  },
  {
    id: "feedbackStyle",
    question: "How should lgtm give you feedback?",
    type: "select",
    options: [
      {
        value: "direct",
        label: "Direct",
        description: "Tell me what's wrong concisely, no sugar-coating",
      },
      {
        value: "gentle",
        label: "Gentle",
        description: "Suggest improvements politely, frame as questions",
      },
      {
        value: "socratic",
        label: "Socratic",
        description: "Ask me questions that guide me to the answer",
      },
      {
        value: "minimal",
        label: "Minimal",
        description: "Only flag critical issues, skip the rest",
      },
    ],
    default: "direct",
  },
  {
    id: "teamSize",
    question: "Team size?",
    type: "select",
    options: [
      { value: "solo", label: "Solo", description: "Just me" },
      { value: "small", label: "Small", description: "2-5 developers" },
      { value: "large", label: "Large", description: "6+ developers" },
    ],
    default: "solo",
  },
  {
    id: "aiProvider",
    question: "LLM provider for AI features? (or none to disable)",
    type: "select",
    options: [
      { value: "none", label: "None", description: "Disable AI features" },
      {
        value: "openai",
        label: "OpenAI",
        description: "GPT-4o, GPT-4o-mini, etc.",
      },
      {
        value: "anthropic",
        label: "Anthropic",
        description: "Claude Sonnet, Opus, etc.",
      },
      {
        value: "ollama",
        label: "Ollama (local)",
        description: "Run models locally — private, no API costs",
      },
    ],
    default: "none",
  },
  {
    id: "aiModel",
    question: "Which model? (or skip for default)",
    type: "text",
    default: "",
  },
];
