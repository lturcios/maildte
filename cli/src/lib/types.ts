export interface AccountConfig {
  id: string;
  alias: string;
  email: string;
}

export interface CliConfig {
  apiUrl: string;
  apiKey: string;
  destDir: string;
  accounts: AccountConfig[];
}

export interface AccountState {
  cursor: string | null;
}

export type StateFile = Record<string, AccountState>;

export type FileType = 'JSON' | 'PDF';

export interface ManifestEntry {
  attachmentId: string;
  relativePath: string;
  fileType: FileType;
  sizeBytes: number;
  sha256: string;
  createdAt: string;
  receivedAt: string;
  senderEmail: string;
  missing: boolean;
}

export interface ManifestMeta {
  nextCursor: string | null;
  maxCreatedAt: string | null;
  totalFiles: number;
  totalBytes: number;
  missingFiles: number;
}

export interface ManifestPage {
  data: ManifestEntry[];
  meta: ManifestMeta;
}

export interface RemoteAccount {
  id: string;
  alias: string;
  email: string;
  folderName: string;
  status: string;
}
