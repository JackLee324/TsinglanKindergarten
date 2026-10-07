export function Spinner({ label }: { readonly label?: string }) {
  return (
    <div className="flex items-center justify-center gap-3 py-10" data-testid="loading">
      <span className="size-5 animate-spin rounded-full border-2 border-primary/30 border-t-primary" />
      {label !== undefined && <span className="text-sm text-muted-foreground">{label}</span>}
    </div>
  )
}
