export type RiskClass = 'read' | 'network' | 'write' | 'exec' | 'admin';

export type PermissionRequest = {
  capabilityId: string;
  risk: RiskClass;
  action: string;
  details: string;
};

export type ApprovalPrompt = (request: PermissionRequest) => Promise<boolean>;

export class PermissionManager {
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly options: {
      autoApprove: boolean;
      approve?: ApprovalPrompt;
      onDecision?: (request: PermissionRequest, approved: boolean) => void;
    },
  ) {}

  async authorize(request: PermissionRequest): Promise<void> {
    if (request.risk === 'read') return;
    const approved = this.options.autoApprove ? true : await this.enqueue(request);
    this.options.onDecision?.(request, approved);
    if (!approved) {
      throw new Error(`Permission denied for ${request.capabilityId}: ${request.action}`);
    }
  }

  private enqueue(request: PermissionRequest): Promise<boolean> {
    const decision = this.queue.then(async () => {
      if (!this.options.approve) return false;
      return this.options.approve(request);
    });
    this.queue = decision.then(
      () => undefined,
      () => undefined,
    );
    return decision;
  }
}
