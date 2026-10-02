/**
 * List fully-qualified model IDs from OpenCode provider metadata.
 * @param providers - Provider metadata returned by OpenCode config.providers()
 * @returns Fully-qualified model IDs in provider/model form
 */
export function listModelIds(providers: unknown[]): string[] {
  return providers.flatMap((provider) => getProviderModelIds(provider));
}

/**
 * Get the OpenCode provider ID from provider metadata.
 * @param provider - Provider metadata returned by OpenCode config.providers()
 * @returns Provider ID when present
 */
export function getProviderId(provider: unknown): string | undefined {
  if (!isRecord(provider)) {
    return undefined;
  }

  return typeof provider.id === 'string' ? provider.id : typeof provider.name === 'string' ? provider.name : undefined;
}

/**
 * List fully-qualified model IDs for one OpenCode provider.
 * @param provider - Provider metadata returned by OpenCode config.providers()
 * @returns Fully-qualified model IDs in provider/model form
 */
export function getProviderModelIds(provider: unknown): string[] {
  const providerId = getProviderId(provider);
  if (!isRecord(provider) || !providerId) {
    return [];
  }

  return getModelIds(provider.models).map((modelId) => `${providerId}/${modelId}`);
}

function getModelIds(models: unknown): string[] {
  if (Array.isArray(models)) {
    return models.map(getModelId).filter((model): model is string => Boolean(model));
  }

  if (isRecord(models)) {
    return Object.entries(models)
      .map(([key, model]) => getModelId(model) ?? key)
      .filter((model): model is string => Boolean(model));
  }

  return [];
}

function getModelId(model: unknown): string | undefined {
  if (typeof model === 'string') {
    return model;
  }

  if (isRecord(model) && typeof model.id === 'string') {
    return model.id;
  }

  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
