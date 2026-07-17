import { inferModelCapabilities } from './config.js';
import { providerAdapters } from './providers.js';

export class GatewayRouter {
  constructor(config, stateStore) {
    this.config = config;
    this.stateStore = stateStore;
  }

  listModels() {
    return {
      object: 'list',
      data: this.config.models.map((model) => ({
        id: model.id,
        object: 'model',
        created: 0,
        owned_by: model.providerId || 'local-router',
        _capabilities: model.capabilities || inferModelCapabilities(model),
      })),
    };
  }

  resolveModel(modelId, capability) {
    const requestedModel = String(modelId || this.config.defaultModel || '').trim();
    const route = this.config.models.find((model) => model.id === requestedModel);
    if (!route) {
      const error = new Error(`model route not found: ${requestedModel}`);
      error.status = 404;
      throw error;
    }
    const capabilities = route.capabilities || inferModelCapabilities(route);
    if (capability && !capabilities.includes(capability)) {
      const error = new Error(`model ${requestedModel} does not support ${capability === 'image' ? 'image generation' : 'chat completions'}`);
      error.status = 400;
      throw error;
    }
    if (route.strategy === 'fallback' && route.candidates?.length) {
      return { requestedModel, capabilities, candidates: route.candidates };
    }
    if (!route.providerId || !route.upstreamModel) {
      const error = new Error(`model route ${route.id} missing providerId/upstreamModel`);
      error.status = 500;
      throw error;
    }
    return {
      requestedModel,
      capabilities,
      candidates: [{ providerId: route.providerId, model: route.upstreamModel }],
    };
  }

  async chatCompletions(requestBody) {
    return this.executeOperation({
      requestBody,
      capability: 'chat',
      adapterMethod: 'chatCompletions',
    });
  }

  async imageGenerations(requestBody) {
    return this.executeOperation({
      requestBody,
      capability: 'image',
      adapterMethod: 'imagesGenerations',
    });
  }

  async responses(requestBody) {
    return this.executeOperation({
      requestBody,
      adapterMethod: 'responses',
    });
  }

  async executeOperation({ requestBody, capability, adapterMethod }) {
    const route = this.resolveModel(requestBody.model, capability);
    const failures = [];

    for (const candidate of route.candidates) {
      if (capability && !candidateSupportsCapability(candidate, capability)) {
        failures.push({
          providerId: candidate.providerId,
          model: candidate.model,
          error: `candidate model ${candidate.model} does not support ${capability}`,
        });
        continue;
      }

      const provider = this.config.providers.find((item) => item.id === candidate.providerId && item.enabled !== false);
      if (!provider) {
        failures.push({ providerId: candidate.providerId, error: 'provider missing or disabled' });
        continue;
      }

      const adapter = providerAdapters.get(provider.kind);
      if (!adapter || typeof adapter[adapterMethod] !== 'function') {
        failures.push({ providerId: provider.id, error: `adapter method ${adapterMethod} not registered for ${provider.kind}` });
        continue;
      }

      const accounts = this.stateStore.pickAccounts(provider.id, this.config.accounts, candidate.accountIds);
      if (!accounts.length) {
        failures.push({ providerId: provider.id, error: 'no available account' });
        continue;
      }

      for (const account of accounts) {
        try {
          const proxy = this.resolveProxy(account.proxyId || provider.defaultProxyId);
          const response = await adapter[adapterMethod](
            { ...requestBody, model: route.requestedModel },
            {
              provider,
              account,
              upstreamModel: candidate.model,
              proxyUrl: proxy?.url,
              timeoutMs: provider.timeoutMs || this.config.errorPolicy.requestTimeoutMs,
            },
          );
          this.stateStore.markSuccess(account, {
            providerLabel: provider.label,
            upstreamModel: candidate.model,
            statusCode: 200,
          });
          return decorateGatewayResponse(response, route.requestedModel, {
            providerId: provider.id,
            providerLabel: provider.label,
            accountId: account.id,
            accountLabel: account.label,
            upstreamModel: candidate.model,
          });
        } catch (error) {
          const kind = adapter.classifyError(error);
          this.stateStore.markFailure(account, kind, error, {
            cooldownSeconds: this.config.errorPolicy.cooldownSeconds,
          });
          failures.push({
            providerId: provider.id,
            accountId: account.id,
            kind,
            status: error?.status || null,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }

    const error = new Error('No available provider/account/model candidate');
    error.status = failures.some((failure) => String(failure?.error || '').includes('does not support')) ? 400 : 503;
    error.failures = failures;
    throw error;
  }

  resolveProxy(proxyId) {
    if (!proxyId) return null;
    const proxy = this.config.proxies.find((item) => item.id === proxyId);
    if (!proxy || proxy.type === 'direct') return null;
    return proxy;
  }
}

function decorateGatewayResponse(response, requestedModel, gateway) {
  const payload = response && typeof response === 'object' && !Array.isArray(response)
    ? { ...response }
    : { value: response };
  if (!payload.model && requestedModel) payload.model = requestedModel;
  payload._gateway = gateway;
  return payload;
}

function candidateSupportsCapability(candidate, capability) {
  return inferModelCapabilities({
    id: candidate.model,
    upstreamModel: candidate.model,
    capabilities: candidate.capabilities,
  }).includes(capability);
}
