import React from 'react';

import { BladeInterface } from './components/BladeInterface.js';
import { ErrorBoundary } from './components/ErrorBoundary.js';
import { NotificationSystem } from './components/NotificationSystem.js';
import { AppProvider } from './contexts/AppContext.js';
import { SessionProvider } from './contexts/SessionContext.js';

interface AppProps {
  debug?: boolean;
  testMode?: boolean;
}

// 包装器组件 - 提供会话上下文和错误边界
export const AppWrapper: React.FC<AppProps> = (props) => {
  return (
    <ErrorBoundary>
      <AppProvider>
        <SessionProvider>
          <BladeInterface {...props} />
          <NotificationSystem />
        </SessionProvider>
      </AppProvider>
    </ErrorBoundary>
  );
};

export default AppWrapper;
