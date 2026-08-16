/**
 * Onboarding module — interactive first-time setup.
 */

export { runOnboarding, isOnboardingComplete } from "./flow.js";
export { detectTechStack } from "./detect.js";
export { ONBOARDING_QUESTIONS } from "./questions.js";
export type { OnboardingQuestion } from "./questions.js";
