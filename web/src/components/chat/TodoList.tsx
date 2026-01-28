import type { TodoItem } from '@/store/session'
import { cn } from '@/lib/utils'

function TodoItemRow({ item }: { item: TodoItem }) {
  const getStatusIcon = () => {
    switch (item.status) {
      case 'completed':
        return <span className="text-[#9CA3AF] dark:text-[#71717a]">✓</span>
      case 'in_progress':
        return <span className="text-[#16A34A]">▶</span>
      default:
        return <span className="text-[#9CA3AF] dark:text-[#71717a]">○</span>
    }
  }

  return (
    <div className="flex items-center gap-2">
      <span className="text-[13px] font-mono">{getStatusIcon()}</span>
      <span
        className={cn(
          'text-[13px] font-mono',
          item.status === 'completed'
            ? 'text-[#9CA3AF] dark:text-[#71717a]'
            : 'text-[#111827] dark:text-[#E5E5E5]'
        )}
      >
        {item.content}
      </span>
    </div>
  )
}

interface TodoListProps {
  todos: TodoItem[]
}

export function TodoList({ todos }: TodoListProps) {
  if (!todos || todos.length === 0) return null

  const completed = todos.filter((t) => t.status === 'completed').length
  const total = todos.length

  return (
    <div className="bg-[#F3F4F6] dark:bg-[#18181b] rounded-md p-3 space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-[12px] text-[#6B7280] dark:text-[#71717a] font-mono">Tasks</span>
        <span className="text-[12px] text-[#6B7280] dark:text-[#71717a] font-mono">
          {completed}/{total}
        </span>
      </div>
      <div className="space-y-1">
        {todos.map((item) => (
          <TodoItemRow key={item.id} item={item} />
        ))}
      </div>
    </div>
  )
}
