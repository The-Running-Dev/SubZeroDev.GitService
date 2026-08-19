interface ActionButtonProps {
  readonly testId: string;
  readonly disabled: boolean;
  readonly label: string;
  readonly onAction: () => void;
}

export function ActionButton({ testId, disabled, label, onAction }: ActionButtonProps) {
  return (
    <button type="button" data-testid={testId} disabled={disabled} onClick={onAction}>
      {label}
    </button>
  );
}
