import { Link } from 'react-router-dom'
import { Button } from '@/components/ui/button'

export function NotFoundPage() {
  return (
    <div className="flex h-screen w-full flex-col items-center justify-center bg-zinc-50 dark:bg-zinc-950 p-4">
      <div className="text-center space-y-5 max-w-md">
        <h1 className="text-8xl font-black text-zinc-200 dark:text-zinc-800">404</h1>
        <h2 className="text-2xl font-bold tracking-tight text-zinc-900 dark:text-zinc-100">
          Trang không tồn tại
        </h2>
        <p className="text-zinc-500 dark:text-zinc-400">
          Xin lỗi, chúng tôi không thể tìm thấy trang bạn đang yêu cầu. Vui lòng kiểm tra lại đường dẫn hoặc quay về trang chủ.
        </p>
        <div className="pt-4">
          <Button asChild className="rounded-xl bg-primary hover:bg-primary/90 text-primary-foreground px-8">
            <Link to="/">Quay về trang chủ</Link>
          </Button>
        </div>
      </div>
    </div>
  )
}
