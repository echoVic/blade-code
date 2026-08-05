import { useEffect } from 'react';
import { ChatView } from '@/components/chat/ChatView';
import { Layout } from '@/components/layout/Layout';
import { TaskHome } from '@/components/tasks/TaskHome';
import { useSessionStore } from '@/store/session';

function App() {
  const subscribeToTaskEvents = useSessionStore((state) => state.subscribeToTaskEvents);
  const unsubscribeFromTaskEvents = useSessionStore(
    (state) => state.unsubscribeFromTaskEvents
  );
  const currentSessionRef = useSessionStore((state) => state.currentSessionRef);
  const isTemporarySession = useSessionStore((state) => state.isTemporarySession);

  useEffect(() => {
    void subscribeToTaskEvents().catch((error) => {
      console.error('Failed to subscribe to task events', error);
    });
    return unsubscribeFromTaskEvents;
  }, [subscribeToTaskEvents, unsubscribeFromTaskEvents]);

  return (
    <Layout>
      {!currentSessionRef || isTemporarySession ? <TaskHome /> : <ChatView />}
    </Layout>
  );
}

export default App;
