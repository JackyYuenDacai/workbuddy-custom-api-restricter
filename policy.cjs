function createWorkBuddyLocalPolicy() {
  const model = 'Qwen3.8-27B-EXL3-3.5bpw';
  const id = 'custom-local:' + model;
  const base = 'http://127.0.0.1:8317/v1';
  const fail = (message) => {
    const error = new Error('[WorkBuddy local-only] ' + message);
    error.code = 'WORKBUDDY_MODEL_POLICY_DENIED';
    throw error;
  };
  const allowed = (value) => value === model || value === id;
  function assertModel(value) {
    if (!allowed(value)) fail('Only ' + model + ' is permitted.');
  }
  function localConfig(config) {
    if (!config || !allowed(config.id)) fail('The configured local Qwen model is unavailable; cloud fallback is disabled.');
    if (config.disabled) fail('The configured local Qwen model is disabled.');
    return {...config, id, name: model, url: base, useCustomProtocol: false,
      local: false, tags: [...new Set([...(config.tags || []), 'custom'])], aliases: []};
  }
  function filterModels(models) {
    const match = (models || []).find(m => m.id === id) || (models || []).find(m => m.id === model);
    return match ? [localConfig(match)] : [];
  }
  function restrictProduct(config) {
    // Keep auth endpoints, search tools, telemetry and all non-model services intact.
    return {...config, models: filterModels(config.models), availableModels: [id, model],
      agents: config.agents?.map(agent => ({...agent, models: [id], model: id, declaredModel: id})),
      modelPromotions: [], modelTiers: []};
  }
  function select(manager) {
    return localConfig(manager.findModelByIdOrName(id) || manager.findModelByIdOrName(model));
  }
  function guardRequest(request) {
    assertModel(request.modelId);
    let url;
    try { url = new URL(request.url); } catch { fail('Invalid inference URL.'); }
    if (url.origin !== 'http://127.0.0.1:8317' || url.pathname !== '/v1/chat/completions' ||
        url.username || url.password || url.search || url.hash) fail('Inference endpoint is not the approved local Chat Completions endpoint.');
    if (String(request.method).toUpperCase() !== 'POST') fail('Only Chat Completions POST is permitted.');
    let body;
    try { body = typeof request.data === 'string' ? JSON.parse(request.data) : request.data; }
    catch { fail('Invalid inference JSON.'); }
    if (!body || body.model !== model) fail('The outgoing model ID is not the approved Qwen model.');
    // No redirect to a cloud endpoint and no inherited system/HTTP proxy for inference.
    request.maxRedirects = 0;
    request.proxy = false;
    // Axios request interceptors run before transforms. Check again after their transforms.
    const transforms = request.transformRequest;
    request.transformRequest = [...(Array.isArray(transforms) ? transforms : transforms ? [transforms] : []), function(data) {
      let finalBody;
      try { finalBody = typeof data === 'string' ? JSON.parse(data) : data; } catch { fail('Invalid transformed inference JSON.'); }
      if (!finalBody || finalBody.model !== model) fail('A request interceptor changed the model.');
      if (this.url !== base + '/chat/completions') fail('A request interceptor changed the endpoint.');
      this.maxRedirects = 0;
      this.proxy = false;
      return typeof data === 'string' ? data : JSON.stringify(data);
    }];
    return request;
  }
  return Object.freeze({model, id, base, allowed, assertModel, filterModels, localConfig, restrictProduct, select, guardRequest});
}
module.exports = createWorkBuddyLocalPolicy;
