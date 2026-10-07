import { Link } from 'react-router-dom'
import { EmptyState } from '../components/ui/EmptyState'
import { Button } from '../components/ui/Button'

export function NotFoundPage() {
  return (
    <div data-testid="not-found-page">
      <EmptyState
        title="页面不存在"
        description="这个地址没有对应的页面。"
        action={
          <Link to="/">
            <Button>回到首页</Button>
          </Link>
        }
        testId="not-found"
      />
    </div>
  )
}
