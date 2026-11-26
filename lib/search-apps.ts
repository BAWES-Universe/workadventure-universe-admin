/**
 * The Apps that only look something up (Exa, Tavily): nothing is sent or delivered anywhere by them, so no line about one of them says
 * "sent" or "delivered": they confirm a step completed. Every App of the Instant table is here (a test holds that); an App that sends something is not.
 */
export const SEARCH_TOOLKITS: readonly string[] = ['exa', 'tavily'];
export const isSearchToolkit = (toolkit: string): boolean => SEARCH_TOOLKITS.includes(toolkit.trim().toLowerCase());
