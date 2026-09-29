import React, { type ReactNode } from 'react';
export type ProviderPolicyState = 'loading' | 'error' | 'user' | 'deployment';
export function ProviderPolicyGate({state,children}:{state:ProviderPolicyState;children:ReactNode}) {
 if(state==='user') return <>{children}</>;
 return <p role="status" className="text-sm p-4">{state==='deployment'
  ? 'Voice providers and models are managed by this deployment. Personal API keys and provider changes are disabled.'
  : state==='error' ? 'Could not load provider permissions. Reload this page to try again.'
  : 'Loading provider permissions…'}</p>;
}
