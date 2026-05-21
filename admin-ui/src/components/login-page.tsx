import { useState, useEffect } from 'react'
import { KeyRound } from 'lucide-react'
import { storage } from '@/lib/storage'
import { getCredentials } from '@/api/credentials'
import { extractErrorMessage } from '@/lib/utils'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'

interface LoginPageProps {
  onLogin: (apiKey: string) => void
}

export function LoginPage({ onLogin }: LoginPageProps) {
  const [apiKey, setApiKey] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    // 从 storage 读取保存的 API Key
    const savedKey = storage.getApiKey()
    if (savedKey) {
      setApiKey(savedKey)
    }
  }, [])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    const key = apiKey.trim()
    if (!key || isSubmitting) {
      return
    }

    setIsSubmitting(true)
    setError(null)
    storage.setApiKey(key)

    try {
      await getCredentials()
      onLogin(key)
    } catch (err) {
      storage.removeApiKey()
      setError(extractErrorMessage(err))
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-primary/10">
            <KeyRound className="h-6 w-6 text-primary" />
          </div>
          <CardTitle className="text-2xl">Kiro Admin</CardTitle>
          <CardDescription>
            请输入 Admin API Key 以访问管理面板
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <Input
                type="password"
                placeholder="Admin API Key"
                value={apiKey}
                onChange={(e) => {
                  setApiKey(e.target.value)
                  setError(null)
                }}
                className="text-center"
                disabled={isSubmitting}
              />
            </div>
            {error && (
              <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {error}
              </div>
            )}
            <Button type="submit" className="w-full" disabled={!apiKey.trim() || isSubmitting}>
              {isSubmitting ? '登录中...' : '登录'}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}
