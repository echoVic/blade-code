import { useSessionStore, type TodoItem } from '@/store/SessionStore'
import { cn } from '@/lib/utils'

function TodoItemRow({ item }: { item: TodoItem }) {
  const getStatusIcon = () => {
    switch (item.status) {
      case 'completed':
        return <span className="text-[#71717a]">✓</span>
      case 'in_progress':
        return <span className="text-[#16A34A]">▶</span>
      default:
        return <span className="text-[#71717a]">○</span>
    }
  }

  return (
    <div className="flex items-center gap-2">
      <span className="text-[13px] font-mono">{getStatusIcon()}</span>
      <span className={cn(
        'text-[13px] font-mono',
        item.status === 'completed' ? 'text-[#71717a]' : 'text-[#E5E5E5]'
      )}>
        {item.content}
      </span>
    </div>
  )
}

export function TodoList() {
  const { todos } = useSessionStore()

  if (todos.length === 0) return null

  const completed = todos.filter(t => t.status === 'completed').length
  const total = todos.length

  return (
    <div className="bg-[#18181b] rounded-md p-3 space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-[12px] text-[#71717a] font-mono">Tasks</span>
        <span className="text-[12px] text-[#71717a] font-mono">{completed}/{total}</span>
      </div>
      <div className="space-y-1">
        {todos.map((item) => (
          <TodoItemRow key={item.id} item={item} />
        ))}
      </div>
    </div>
  )
}

export function InlineTodoList({ todos }: { todos: TodoItem[] }) {
  if (todos.length === 0) return null

  const completed = todos.filter(t => t.status === 'completed').length
  const total = todos.length

  return (
    <div className="bg-[#18181b] rounded-md p-3 space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-[12px] text-[#71717a] font-mono">Tasks</span>
        <span className="text-[12px] text-[#71717a] font-mono">{completed}/{total}</span>
      </div>
      <div className="space-y-1">
        {todos.map((item) => (
          <TodoItemRow key={item.id} item={item} />
        ))}
      </div>
    </div>
  )
}
