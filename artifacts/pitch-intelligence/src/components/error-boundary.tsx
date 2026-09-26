import { Component, type ReactNode } from "react"
import { AlertCircle, RefreshCcw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"

interface Props {
  children: ReactNode
  resetKey?: any
}

interface State {
  hasError: boolean
  error: Error | null
}

export class ErrorBoundary extends Component<Props, State> {
  public state: State = {
    hasError: false,
    error: null,
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error }
  }

  componentDidUpdate(prevProps: Props) {
    if (this.props.resetKey !== prevProps.resetKey) {
      this.setState({ hasError: false, error: null })
    }
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-[100dvh] w-full flex items-center justify-center bg-slate-50 dark:bg-slate-950 p-4">
          <Card className="w-full max-w-md shadow-lg border-slate-200 dark:border-slate-800">
            <CardContent className="pt-10 pb-10 flex flex-col items-center text-center">
              <div className="bg-destructive/10 p-4 rounded-full mb-6">
                <AlertCircle className="h-10 w-10 text-destructive" />
              </div>
              <h1 className="text-2xl font-bold tracking-tight mb-2">Something went wrong</h1>
              <p className="text-muted-foreground mb-8 text-sm max-w-sm">
                {this.state.error?.message || "An unexpected error occurred in the application."}
              </p>
              <Button 
                onClick={() => this.setState({ hasError: false, error: null })}
                className="w-full sm:w-auto"
              >
                <RefreshCcw className="mr-2 h-4 w-4" />
                Try again
              </Button>
            </CardContent>
          </Card>
        </div>
      )
    }

    return this.props.children
  }
}
