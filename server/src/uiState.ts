import type {
  AppSettings,
  ConnectionAuthMode,
  ConnectionKind,
  FieldOverrides,
  ParamValues,
  PromptBlock,
  RandomPromptConfig,
  SystemPromptInput,
} from '@latent/shared';

/** Everything one workflow's form was arranged into. */
export interface WorkflowUiState {
  overrides: FieldOverrides;
  lastValues: ParamValues;
  layouts: { name: string; overrides: FieldOverrides; active: boolean }[];
  presets: { name: string; values: ParamValues }[];
}

/**
 * The arrangement half of the database, in a shape that can live in a file.
 *
 * Workflows are keyed by *name*, not id. Ids are generated at import time, so a
 * re-imported workflow is a different row with the same name — and matching on
 * the name is the only thing that lets a form layout survive the database it was
 * made in being deleted.
 */
export interface UiState {
  version: 1;
  savedAt: number;
  settings: AppSettings;
  connections: {
    /** Absent in a file written before model servers lived in this list. */
    kind?: ConnectionKind;
    name: string;
    url: string;
    authMode: ConnectionAuthMode;
    username: string | null;
    secret: string | null;
    allowSelfSigned: boolean;
    active: boolean;
  }[];
  /**
   * The named instructions, which are worth more than the workflows using them.
   *
   * A paragraph telling a captioner how to describe a picture is written once
   * and refined for months; losing it with the database would be losing the
   * work, not the wiring.
   */
  systemPrompts?: SystemPromptInput[];
  variation: {
    config: RandomPromptConfig;
    presets: { name: string; config: RandomPromptConfig }[];
  };
  workflows: Record<string, WorkflowUiState>;
}

/** The prompt library, in its own file so it can be copied around on its own. */
export interface BlockState {
  version: 1;
  savedAt: number;
  blocks: Omit<PromptBlock, 'id' | 'createdAt'>[];
}
