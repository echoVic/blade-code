import { Box, Text } from 'ink';
import React, { useEffect } from 'react';
import { useNotifications } from '../contexts/AppContext.js';

interface NotificationSystemProps {
  position?: 'top-right' | 'top-left' | 'bottom-right' | 'bottom-left';
  maxNotifications?: number;
  autoDismiss?: boolean;
  dismissDelay?: number;
}

export const NotificationSystem: React.FC<NotificationSystemProps> = ({
  position = 'top-right',
  maxNotifications = 5,
  autoDismiss = true,
  dismissDelay = 5000,
}) => {
  const { notifications, removeNotification } = useNotifications();

  // 位置样式映射
  const positionStyles = {
    'top-right': { top: 1, right: 1 },
    'top-left': { top: 1, left: 1 },
    'bottom-right': { bottom: 1, right: 1 },
    'bottom-left': { bottom: 1, left: 1 },
  };

  // 颜色映射
  const colorMap = {
    info: { bg: '#2563EB', text: '#DBEAFE', icon: 'ℹ️' },
    success: { bg: '#16A34A', text: '#DCFAE6', icon: '✅' },
    warning: { bg: '#EA580C', text: '#FED7AA', icon: '⚠️' },
    error: { bg: '#DC2626', text: '#FECACA', icon: '❌' },
  };

  // 显示的通知（限制数量）
  const displayNotifications = notifications.slice(0, maxNotifications);

  return (
    <Box
      flexDirection="column"
      position="absolute"
      {...positionStyles[position]}
      width={50}
      zIndex={1000}
    >
      {displayNotifications.map((notification, index) => {
        const colors = colorMap[notification.type];
        const style = {
          top: position.includes('top')
            ? (positionStyles[position].top || 0) + index * 4
            : undefined,
          bottom: position.includes('bottom')
            ? (positionStyles[position].bottom || 0) + index * 4
            : undefined,
          [position.includes('left') ? 'left' : 'right']: position.includes('left')
            ? positionStyles[position].left
            : positionStyles[position].right,
        };

        return (
          <NotificationItem
            key={notification.id}
            notification={notification}
            colors={colors}
            style={style}
            autoDismiss={autoDismiss}
            dismissDelay={dismissDelay}
            onDismiss={() => removeNotification(notification.id)}
          />
        );
      })}
    </Box>
  );
};

interface NotificationItemProps {
  notification: ReturnType<typeof useNotifications>['notifications'][0];
  colors: { bg: string; text: string; icon: string };
  style: Record<string, any>;
  autoDismiss: boolean;
  dismissDelay: number;
  onDismiss: () => void;
}

const NotificationItem: React.FC<NotificationItemProps> = ({
  notification,
  colors,
  style,
  autoDismiss,
  dismissDelay,
  onDismiss,
}) => {
  // 自动消失
  useEffect(() => {
    if (autoDismiss && notification.duration !== 0) {
      const duration = notification.duration || dismissDelay;
      const timer = setTimeout(() => {
        onDismiss();
      }, duration);

      return () => clearTimeout(timer);
    }
  }, [autoDismiss, notification.duration, dismissDelay, onDismiss]);

  return (
    <Box
      flexDirection="column"
      position="absolute"
      {...style}
      width={48}
      borderStyle="round"
      borderColor={colors.bg}
      backgroundColor={colors.bg}
      paddingX={1}
      paddingY={0}
    >
      <Box flexDirection="row" alignItems="center" marginBottom={1}>
        <Text color={colors.text}>{colors.icon}</Text>
        <Text color={colors.text} bold marginLeft={1}>
          {notification.title}
        </Text>
      </Box>

      <Text color={colors.text} wrap="wrap">
        {notification.message}
      </Text>

      <Box flexDirection="row" justifyContent="flex-end" marginTop={1}>
        <Text color={colors.text} dimColor underline onPress={onDismiss}>
          关闭
        </Text>
      </Box>
    </Box>
  );
};

// 通知钩子的便捷函数
export const useNotify = () => {
  const { addNotification } = useNotifications();

  const notify = {
    info: (
      title: string,
      message: string,
      options?: Partial<
        Omit<
          ReturnType<typeof useNotifications>['notifications'][0],
          'id' | 'timestamp' | 'type' | 'title' | 'message'
        >
      >
    ) => {
      addNotification({
        type: 'info',
        title,
        message,
        ...options,
      });
    },

    success: (
      title: string,
      message: string,
      options?: Partial<
        Omit<
          ReturnType<typeof useNotifications>['notifications'][0],
          'id' | 'timestamp' | 'type' | 'title' | 'message'
        >
      >
    ) => {
      addNotification({
        type: 'success',
        title,
        message,
        ...options,
      });
    },

    warning: (
      title: string,
      message: string,
      options?: Partial<
        Omit<
          ReturnType<typeof useNotifications>['notifications'][0],
          'id' | 'timestamp' | 'type' | 'title' | 'message'
        >
      >
    ) => {
      addNotification({
        type: 'warning',
        title,
        message,
        ...options,
      });
    },

    error: (
      title: string,
      message: string,
      options?: Partial<
        Omit<
          ReturnType<typeof useNotifications>['notifications'][0],
          'id' | 'timestamp' | 'type' | 'title' | 'message'
        >
      >
    ) => {
      addNotification({
        type: 'error',
        title,
        message,
        ...options,
      });
    },
  };

  return notify;
};
