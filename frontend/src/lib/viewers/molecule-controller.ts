export interface MoleculeViewerController {
  id: string;
  filename: string;
  execute(command: string): Promise<unknown>;
}

type Listener = (controller: MoleculeViewerController | null) => void;

let activeController: MoleculeViewerController | null = null;
const listeners = new Set<Listener>();

export function registerActiveMoleculeViewer(
  controller: MoleculeViewerController,
): () => void {
  activeController = controller;
  emit();

  return () => {
    if (activeController?.id === controller.id) {
      activeController = null;
      emit();
    }
  };
}

export function getActiveMoleculeViewer(): MoleculeViewerController | null {
  return activeController;
}

export async function executeMoleculeViewerCommand(command: string): Promise<unknown> {
  if (!activeController) {
    throw new Error("No active molecule viewer");
  }
  return activeController.execute(command);
}

export function subscribeActiveMoleculeViewer(listener: Listener): () => void {
  listeners.add(listener);
  listener(activeController);
  return () => listeners.delete(listener);
}

function emit() {
  for (const listener of listeners) listener(activeController);
}
