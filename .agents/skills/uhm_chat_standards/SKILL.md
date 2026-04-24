---
name: "Uhm Chat Development Standards"
description: "Guidelines and architecture strict standards for developing and maintaining the uhm-chat application."
---

# Uhm Chat Development Standards

When modifying, maintaining, or adding features to the **Uhm Chat** Web Application (`apps/uhm-chat`), you **MUST** adhere to the following architectural, localization, and performance standards. This application consumes the core SDK but is a consumer-facing React App utilizing a modern stack (TailwindCSS, Radix UI, Vite).

## 1. Architecture & Structure (Feature-Based)
- **Route-based Pages (CRITICAL):** All top-level views (e.g., `ChatPage.tsx`, `LoginPage.tsx`, `NotFoundPage.tsx`) MUST be placed in the `src/pages/` directory. `App.tsx` should only be responsible for global context providers and routing logic (e.g., using `react-router-dom`).
- **Feature-Based Modularization (CRITICAL):** Do not dump all components into the global `src/components/` folder. Group related files by domain features (e.g., `src/features/chat/`, `src/features/auth/`, `src/features/settings/`).
- **Core UI Separation:** The `src/components/ui/` directory is strictly reserved for "dumb" UI elements provided by **shadcn/ui** or core design primitives (e.g., `Button.tsx`, `Tabs.tsx`). Do not include any Ermis SDK logic in these primitive components.
- **Smart Hooks over Local State:** Complex calculations and logic should be extracted into the `src/hooks/` or `src/utils/` directory.
- **No Hardcoded Constants (CRITICAL):** Do not hardcode magic strings, token names, or `localStorage` keys directly in the components. Always extract them into a centralized constants file (e.g., `src/utils/constants.ts`) to ensure single-source-of-truth and prevent typos.

## 2. i18n & Localization
- **NO Hardcoded Strings (CRITICAL):** You must **never** hardcode English or Vietnamese strings directly into JSX textual nodes (e.g., `<span>Đăng nhập</span>`).
- **Use react-i18next:** Always import the translation hook `useTranslation` and use it for any visible text.
  ```tsx
  // BAD
  <button>Gửi tin nhắn</button>
  // GOOD
  const { t } = useTranslation();
  <button>{t('chat.sendMessage')}</button>
  ```
- **Dictionary Files:** All translations must be registered and updated in the respective JSON dictionary files located in `src/locales/` (e.g., `src/locales/vi.json`, `src/locales/en.json`).
- **SDK Localization:** Pass the initialized translation instances directly into the Ermis `ChatProvider` configuration to respect the active language.

## 3. Performance Optimization
- **Lazy Loading (Code Splitting):** All top-level route pages (e.g., LoginPage, MainApp) must be dynamically imported using `React.lazy()` and wrapped in `<Suspense>`. This prevents the initial Vite payload from being overly bloated.
- **Memoization for SDK Contexts (CRITICAL):** When passing complex objects or functions as overrides/props into `<ChatProvider>` or underlying Ermis context wrappers, always wrap them in `useMemo` or `useCallback`. Failure to do so will cause catastrophic re-renders whenever realtime data shifts.
- **Strict Clean-Up:** WebSockets and real-time listeners inside `useEffect` must ALWAYS return a clean-up function (e.g. `return () => client.disconnectUser()`) to prevent memory leaks in the browser context.
- **Icon Treeshaking:** When importing icons from `lucide-react`, only import the specific items you need to ensure proper tree-shaking by Vite.

## 4. UI & Styling (TailwindCSS)
- **ONLY TailwindCSS & Radix UI:** Unlike the core Ermis UI Kit, **do not use BEM or raw vanilla CSS** here. Stick firmly to utility classes provided by TailwindCSS and UI building blocks from Radix.
- **Theme Handling:** Use the standard Vite+Tailwind `.dark` class toggling over the core HTML root.

Follow these strict rules for every change within the `uhm-chat` directory.
