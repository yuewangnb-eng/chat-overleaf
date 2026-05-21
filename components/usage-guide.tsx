import { Button } from "~components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle
} from "~components/ui/card"
import { cn } from "~lib/utils"
import { ExternalLink, MousePointer, Settings, Zap, FileText, MessageCircle } from "lucide-react"

export function UsageGuide({
  className,
  ...props
}: React.ComponentPropsWithoutRef<"div">) {
  const handleOpenOverleaf = () => {
    chrome.tabs.create({ url: "https://www.overleaf.com" })
  }

  return (
    <div className={cn("flex flex-col gap-4 p-4", className)} {...props}>
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-xl flex items-center gap-2">
            <Zap className="h-5 w-5 text-blue-600" />
            Chat Overleaf Extended 使用指南
          </CardTitle>
          <CardDescription>
            AI 驱动的 Overleaf 写作助手，让学术写作更高效
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* 使用步骤 */}
          <div className="space-y-3">
            <h3 className="text-sm font-semibold text-gray-800 flex items-center gap-2">
              <MousePointer className="h-4 w-4" />
              如何使用
            </h3>
            
            <div className="space-y-3 text-sm">
              <div className="flex gap-3 p-3 bg-blue-50 rounded-lg border border-blue-200">
                <div className="flex-shrink-0 w-6 h-6 bg-blue-600 text-white rounded-full flex items-center justify-center text-xs font-bold">
                  1
                </div>
                <div>
                  <div className="font-medium text-blue-800">访问 Overleaf</div>
                  <div className="text-blue-700 text-xs mt-1">
                    打开 Overleaf 网站并进入任意项目的编辑页面
                  </div>
                </div>
              </div>

              <div className="flex gap-3 p-3 bg-green-50 rounded-lg border border-green-200">
                <div className="flex-shrink-0 w-6 h-6 bg-green-600 text-white rounded-full flex items-center justify-center text-xs font-bold">
                  2
                </div>
                <div>
                  <div className="font-medium text-green-800">点击聊天图标</div>
                  <div className="text-green-700 text-xs mt-1">
                    在页面右下角找到聊天图标并点击打开 AI 助手
                  </div>
                </div>
              </div>

              <div className="flex gap-3 p-3 bg-purple-50 rounded-lg border border-purple-200">
                <div className="flex-shrink-0 w-6 h-6 bg-purple-600 text-white rounded-full flex items-center justify-center text-xs font-bold">
                  3
                </div>
                <div>
                  <div className="font-medium text-purple-800">配置 API Key</div>
                  <div className="text-purple-700 text-xs mt-1">
                    首次使用需要在设置中配置 AI 模型的 API Key
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* 主要功能 */}
          <div className="space-y-3">
            <h3 className="text-sm font-semibold text-gray-800 flex items-center gap-2">
              <Zap className="h-4 w-4" />
              主要功能
            </h3>
            
            <div className="grid grid-cols-1 gap-2 text-xs">
              <div className="flex items-center gap-2 p-2 bg-gray-50 rounded">
                <MessageCircle className="h-3 w-3 text-blue-600" />
                <span>智能对话：与 AI 讨论学术问题</span>
              </div>
              <div className="flex items-center gap-2 p-2 bg-gray-50 rounded">
                <FileText className="h-3 w-3 text-green-600" />
                <span>文档分析：自动提取项目文件内容</span>
              </div>
              <div className="flex items-center gap-2 p-2 bg-gray-50 rounded">
                <Settings className="h-3 w-3 text-purple-600" />
                <span>多模型支持：DeepSeek、Kimi、Qwen 等</span>
              </div>
            </div>
          </div>

          {/* 操作按钮 */}
          <div className="flex gap-2 pt-2">
            <Button 
              onClick={handleOpenOverleaf}
              className="flex-1 text-xs h-8"
              size="sm"
            >
              <ExternalLink className="h-3 w-3 mr-1" />
              打开 Overleaf
            </Button>
          </div>

          {/* 提示信息 */}
          <div className="text-xs text-gray-500 bg-yellow-50 border border-yellow-200 rounded p-2">
            <div className="font-medium text-yellow-800 mb-1">💡 提示</div>
            <div className="text-yellow-700">
              此插件专为 Overleaf 编辑页面设计，其他页面将不会显示打开按钮。
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
