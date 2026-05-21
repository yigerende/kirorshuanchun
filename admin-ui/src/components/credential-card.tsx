import { useState } from 'react'
import { toast } from 'sonner'
import { RefreshCw, ChevronUp, ChevronDown, Trash2, Loader2, Pencil, LogIn } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Switch } from '@/components/ui/switch'
import { Input } from '@/components/ui/input'
import { Checkbox } from '@/components/ui/checkbox'
import { Progress } from '@/components/ui/progress'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import type { CredentialStatusItem, BalanceResponse } from '@/types/api'
import { maskProxyUrl, extractErrorMessage } from '@/lib/utils'
import {
  useSetDisabled,
  useSetPriority,
  useResetFailure,
  useDeleteCredential,
  useForceRefreshToken,
  useResetSuccessCount,
} from '@/hooks/use-credentials'
import { EditCredentialDialog } from '@/components/edit-credential-dialog'
import { UpdateTokenDialog } from '@/components/update-token-dialog'
import { ReloginDialog } from '@/components/relogin-dialog'

interface CredentialCardProps {
  credential: CredentialStatusItem
  selected: boolean
  onToggleSelect: () => void
  balance: BalanceResponse | null
  loadingBalance: boolean
}


function formatLastUsed(lastUsedAt: string | null): string {
  if (!lastUsedAt) return '从未使用'
  const date = new Date(lastUsedAt)
  const now = new Date()
  const diff = now.getTime() - date.getTime()
  if (diff < 0) return '刚刚'
  const seconds = Math.floor(diff / 1000)
  if (seconds < 60) return `${seconds} 秒前`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  const days = Math.floor(hours / 24)
  return `${days} 天前`
}

function formatNumber(num: number): string {
  return num.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function formatResetDate(timestamp: number | null): string {
  if (!timestamp) return '未知'
  return new Date(timestamp * 1000).toLocaleString('zh-CN')
}

export function CredentialCard({
  credential,
  selected,
  onToggleSelect,
  balance,
  loadingBalance,
}: CredentialCardProps) {
  const [editingPriority, setEditingPriority] = useState(false)
  const [priorityValue, setPriorityValue] = useState(String(credential.priority))
  const [showDeleteDialog, setShowDeleteDialog] = useState(false)
  const [showEditDialog, setShowEditDialog] = useState(false)
  const [showUpdateTokenDialog, setShowUpdateTokenDialog] = useState(false)
  const [showReloginDialog, setShowReloginDialog] = useState(false)

  const setDisabled = useSetDisabled()
  const setPriority = useSetPriority()
  const resetFailure = useResetFailure()
  const deleteCredential = useDeleteCredential()
  const forceRefresh = useForceRefreshToken()
  const resetSuccess = useResetSuccessCount()

  const handleToggleDisabled = () => {
    setDisabled.mutate(
      { id: credential.id, disabled: !credential.disabled },
      {
        onSuccess: (res) => {
          toast.success(res.message)
        },
        onError: (err) => {
          toast.error('操作失败: ' + (err as Error).message)
        },
      }
    )
  }

  const handlePriorityChange = () => {
    const newPriority = parseInt(priorityValue, 10)
    if (isNaN(newPriority) || newPriority < 0) {
      toast.error('优先级必须是非负整数')
      return
    }
    setPriority.mutate(
      { id: credential.id, priority: newPriority },
      {
        onSuccess: (res) => {
          toast.success(res.message)
          setEditingPriority(false)
        },
        onError: (err) => {
          toast.error('操作失败: ' + (err as Error).message)
        },
      }
    )
  }

  const handleReset = () => {
    resetFailure.mutate(credential.id, {
      onSuccess: (res) => {
        toast.success(res.message)
      },
      onError: (err) => {
        toast.error('操作失败: ' + (err as Error).message)
      },
    })
  }

  const handleForceRefresh = () => {
    forceRefresh.mutate(credential.id, {
      onSuccess: (res) => {
        toast.success(res.message)
      },
      onError: (err) => {
        toast.error('刷新失败: ' + extractErrorMessage(err))
      },
    })
  }

  const handleResetSuccess = () => {
    resetSuccess.mutate(credential.id, {
      onSuccess: (res) => {
        toast.success(res.message)
      },
      onError: (err) => {
        toast.error('重置失败: ' + (err as Error).message)
      },
    })
  }

  const handleDelete = () => {
    if (!credential.disabled) {
      toast.error('请先禁用凭据再删除')
      setShowDeleteDialog(false)
      return
    }

    deleteCredential.mutate(credential.id, {
      onSuccess: (res) => {
        toast.success(res.message)
        setShowDeleteDialog(false)
      },
      onError: (err) => {
        toast.error('删除失败: ' + (err as Error).message)
      },
    })
  }

  return (
    <>
      <Card className={credential.isCurrent ? 'ring-2 ring-primary' : ''}>
        <CardHeader className="pb-2">
          <div className="flex items-start gap-2">
            <Checkbox
              className="mt-1 flex-shrink-0"
              checked={selected}
              onCheckedChange={onToggleSelect}
            />
            <div className="flex-1 min-w-0">
              <div className="flex flex-wrap items-center gap-1.5">
                <CardTitle className="text-lg leading-tight">
                  {credential.email || `凭据 #${credential.id}`}
                </CardTitle>
                {credential.isCurrent && (
                  <Badge variant="success">当前</Badge>
                )}
                {credential.disabled && (
                  <Badge variant="destructive">已禁用</Badge>
                )}
                {credential.disabled && credential.disabledReason && (
                  <Badge variant="outline">{credential.disabledReason}</Badge>
                )}
                {credential.authMethod && (
                  <Badge variant="secondary">
                    {credential.authMethod === 'api_key' ? 'API Key' :
                     credential.authMethod === 'idc' ? 'IdC' :
                     credential.authMethod === 'social' ? 'Social' :
                     credential.authMethod}
                  </Badge>
                )}
                {credential.endpoint && (
                  <Badge variant="outline">{credential.endpoint}</Badge>
                )}
              </div>
            </div>
            <div className="flex items-center gap-2 flex-shrink-0">
              <span className="text-sm text-muted-foreground">启用</span>
              <Switch
                checked={!credential.disabled}
                onCheckedChange={handleToggleDisabled}
                disabled={setDisabled.isPending}
              />
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* 信息网格 */}
          <div className="grid grid-cols-2 gap-4 text-sm">
            <div>
              <span className="text-muted-foreground">优先级：</span>
              {editingPriority ? (
                <div className="inline-flex items-center gap-1 ml-1">
                  <Input
                    type="number"
                    value={priorityValue}
                    onChange={(e) => setPriorityValue(e.target.value)}
                    className="w-16 h-7 text-sm"
                    min="0"
                  />
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 w-7 p-0"
                    onClick={handlePriorityChange}
                    disabled={setPriority.isPending}
                  >
                    ✓
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 w-7 p-0"
                    onClick={() => {
                      setEditingPriority(false)
                      setPriorityValue(String(credential.priority))
                    }}
                  >
                    ✕
                  </Button>
                </div>
              ) : (
                <span
                  className="font-medium cursor-pointer hover:underline ml-1"
                  onClick={() => setEditingPriority(true)}
                >
                  {credential.priority}
                  <span className="text-xs text-muted-foreground ml-1">(点击编辑)</span>
                </span>
              )}
            </div>
            <div>
              <span className="text-muted-foreground">失败次数：</span>
              <span className={credential.failureCount > 0 ? 'text-red-500 font-medium' : ''}>
                {credential.failureCount}
              </span>
            </div>
            <div>
              <span className="text-muted-foreground">刷新失败：</span>
              <span className={credential.refreshFailureCount > 0 ? 'text-red-500 font-medium' : ''}>
                {credential.refreshFailureCount}
              </span>
            </div>
            <div className="col-span-2">
              <span className="text-muted-foreground">订阅等级：</span>
              <span className="font-medium">
                {loadingBalance ? (
                  <Loader2 className="inline w-3 h-3 animate-spin" />
                ) : balance?.subscriptionTitle || '未知'}
              </span>
            </div>
            <div>
              <span className="text-muted-foreground">成功次数：</span>
              <span
                className="font-medium cursor-pointer hover:underline"
                onClick={handleResetSuccess}
                title="点击重置成功次数"
              >
                {credential.successCount}
                <span className="text-xs text-muted-foreground ml-1">(点击重置)</span>
              </span>
            </div>
            <div className="col-span-2">
              <span className="text-muted-foreground">最后调用：</span>
              <span className="font-medium">{formatLastUsed(credential.lastUsedAt)}</span>
            </div>
            {credential.maskedApiKey && (
              <div className="col-span-2">
                <span className="text-muted-foreground">API Key：</span>
                <span className="font-mono font-medium">{credential.maskedApiKey}</span>
              </div>
            )}
            {credential.hasProxy && (
              <div className="col-span-2">
                <span className="text-muted-foreground">代理：</span>
                <span className="font-medium font-mono text-xs">{maskProxyUrl(credential.proxyUrl ?? '')}</span>
              </div>
            )}
            {credential.hasProfileArn && (
              <div className="col-span-2">
                <Badge variant="secondary">有 Profile ARN</Badge>
              </div>
            )}
          </div>

          {/* 余额信息 */}
          <div className="rounded-md border bg-muted/20 p-3">
            {loadingBalance ? (
              <div className="flex items-center justify-center gap-2 py-4 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                正在查询余额...
              </div>
            ) : balance ? (
              <div className="space-y-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-xs text-muted-foreground">余额</div>
                    <div className="text-base font-semibold text-green-600">
                      ${formatNumber(balance.remaining)}
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="text-xs text-muted-foreground">订阅</div>
                    <div className="text-sm font-medium">
                      {balance.subscriptionTitle || '未知'}
                    </div>
                  </div>
                </div>
                <div className="space-y-1.5">
                  <div className="flex justify-between text-xs text-muted-foreground">
                    <span>已用 ${formatNumber(balance.currentUsage)}</span>
                    <span>额度 ${formatNumber(balance.usageLimit)}</span>
                  </div>
                  <Progress value={balance.usagePercentage} className="h-2" />
                  <div className="flex justify-between text-xs text-muted-foreground">
                    <span>{balance.usagePercentage.toFixed(1)}% 已使用</span>
                    <span>{(100 - balance.usagePercentage).toFixed(1)}% 剩余</span>
                  </div>
                </div>
                <div className="border-t pt-2 text-xs text-muted-foreground">
                  下次重置：<span className="font-medium text-foreground">{formatResetDate(balance.nextResetAt)}</span>
                </div>
              </div>
            ) : (
              <div className="py-3 text-sm text-muted-foreground">
                余额未查询。点击顶部“查询信息”后会直接显示在卡片中。
              </div>
            )}
          </div>

          {/* 操作按钮 */}
          <div className="flex flex-wrap gap-2 pt-2 border-t">
            <Button
              size="sm"
              variant="outline"
              onClick={handleReset}
              disabled={resetFailure.isPending || (credential.failureCount === 0 && credential.refreshFailureCount === 0)}
            >
              <RefreshCw className="h-4 w-4 mr-1" />
              重置失败
            </Button>
            {credential.authMethod !== 'api_key' && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => setShowReloginDialog(true)}
                title="选择登录方式重新获取 Token 并刷新该凭据"
              >
                <LogIn className="h-4 w-4 mr-1" />
                重新登录
              </Button>
            )}
            <Button
              size="sm"
              variant="outline"
              onClick={handleForceRefresh}
              disabled={forceRefresh.isPending || credential.disabled || credential.authMethod === 'api_key'}
              title={credential.authMethod === 'api_key' ? 'API Key 凭据无需刷新 Token' : credential.disabled ? '已禁用的凭据无法刷新 Token' : '强制刷新 Token'}
            >
              <RefreshCw className={`h-4 w-4 mr-1 ${forceRefresh.isPending ? 'animate-spin' : ''}`} />
              刷新 Token
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                const newPriority = Math.max(0, credential.priority - 1)
                setPriority.mutate(
                  { id: credential.id, priority: newPriority },
                  {
                    onSuccess: (res) => toast.success(res.message),
                    onError: (err) => toast.error('操作失败: ' + (err as Error).message),
                  }
                )
              }}
              disabled={setPriority.isPending || credential.priority === 0}
            >
              <ChevronUp className="h-4 w-4 mr-1" />
              提高优先级
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                const newPriority = credential.priority + 1
                setPriority.mutate(
                  { id: credential.id, priority: newPriority },
                  {
                    onSuccess: (res) => toast.success(res.message),
                    onError: (err) => toast.error('操作失败: ' + (err as Error).message),
                  }
                )
              }}
              disabled={setPriority.isPending}
            >
              <ChevronDown className="h-4 w-4 mr-1" />
              降低优先级
            </Button>
            {credential.authMethod !== 'api_key' && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => setShowUpdateTokenDialog(true)}
                title="手动粘贴新 Token 并更新凭据"
              >
                <RefreshCw className="h-4 w-4 mr-1" />
                重新导入
              </Button>
            )}
            <Button
              size="sm"
              variant="outline"
              onClick={() => setShowEditDialog(true)}
            >
              <Pencil className="h-4 w-4 mr-1" />
              编辑
            </Button>
            <Button
              size="sm"
              variant="destructive"
              onClick={() => setShowDeleteDialog(true)}
              disabled={!credential.disabled}
              title={!credential.disabled ? '需要先禁用凭据才能删除' : undefined}
            >
              <Trash2 className="h-4 w-4 mr-1" />
              删除
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* 删除确认对话框 */}
      <Dialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>确认删除凭据</DialogTitle>
            <DialogDescription>
              您确定要删除凭据 #{credential.id} 吗？此操作无法撤销。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setShowDeleteDialog(false)}
              disabled={deleteCredential.isPending}
            >
              取消
            </Button>
            <Button
              variant="destructive"
              onClick={handleDelete}
              disabled={deleteCredential.isPending || !credential.disabled}
            >
              确认删除
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 编辑凭据对话框 */}
      <EditCredentialDialog
        open={showEditDialog}
        onOpenChange={setShowEditDialog}
        credential={credential}
      />

      {/* 更新 refreshToken 对话框 */}
      <UpdateTokenDialog
        open={showUpdateTokenDialog}
        onOpenChange={setShowUpdateTokenDialog}
        credential={credential}
      />

      {/* 重新登录对话框 */}
      <ReloginDialog
        open={showReloginDialog}
        onOpenChange={setShowReloginDialog}
        credential={credential}
      />
    </>
  )
}
