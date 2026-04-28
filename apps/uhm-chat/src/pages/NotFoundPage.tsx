import { Link } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import { useTranslation } from 'react-i18next'

export function NotFoundPage() {
  const { t } = useTranslation()

  return (
    <div className="flex h-screen w-full flex-col items-center justify-center bg-zinc-50 dark:bg-[#1a1828] p-4">
      <div className="text-center space-y-5 max-w-md">
        <h1 className="text-8xl font-black text-zinc-200 dark:text-zinc-800">404</h1>
        <h2 className="text-2xl font-bold tracking-tight text-zinc-900 dark:text-zinc-100">
          {t('not_found.title')}
        </h2>
        <p className="text-zinc-500 dark:text-zinc-400">
          {t('not_found.description')}
        </p>
        <div className="pt-4">
          <Button asChild className="rounded-xl bg-primary hover:bg-primary/90 text-primary-foreground px-8">
            <Link to="/">{t('not_found.back_home')}</Link>
          </Button>
        </div>
      </div>
    </div>
  )
}
