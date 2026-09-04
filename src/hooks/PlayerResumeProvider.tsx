import React from 'react';
import { PlayerResumeContext } from './useOpenWithResume';
import type { PlayerResumeProviderProps } from './useOpenWithResume';

/**
 * JSX shim for `<PlayerResumeProvider>`. The context itself lives in
 * `useOpenWithResume.ts` (a `.ts` file); the JSX-using component
 * lives here (a `.tsx` file) so TypeScript's legacy JSX transform
 * (`jsx: "react-native"` in the project's tsconfig) can parse the
 * JSX without a `.ts`-file-with-JSX parse error.
 */
export function PlayerResumeProvider({
  lookup,
  children,
}: PlayerResumeProviderProps): React.ReactElement {
  return (
    <PlayerResumeContext.Provider value={lookup}>
      {children}
    </PlayerResumeContext.Provider>
  );
}
