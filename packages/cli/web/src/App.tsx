import { useEffect } from 'react';
import { ChatView } from '@/components/chat/ChatView';
import { Layout } from '@/components/layout/Layout';
import { useSessionStore } from '@/store/session';

function App() {
  const subscribeToTaskEvents = useSessionStore((state) => state.subscribeToTaskEvents);
  const unsubscribeFromTaskEvents = useSessionStore(
    (state) => state.unsubscribeFromTaskEvents
  );

  useEffect(() => {
    void subscribeToTaskEvents().catch((error) => {
      console.error('Failed to subscribe to task events', error);
    });
    return unsubscribeFromTaskEvents;
  }, [subscribeToTaskEvents, unsubscribeFromTaskEvents]);

  return (
    <Layout>
      <ChatView />
    </Layout>
  );
}

export default App;
