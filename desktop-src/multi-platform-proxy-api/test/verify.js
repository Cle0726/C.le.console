const base = 'http://127.0.0.1:13978';

async function main() {
  const health = await get('/healthz');
  assert(health.ok, 'healthz ok');

  const snapshot = await get('/admin/snapshot', { authorization: 'Bearer local-admin-token' });
  assert(snapshot.config.providers.length >= 2, 'providers configured');

  const models = await get('/v1/models');
  const modelMap = new Map(models.data.map((model) => [model.id, model]));
  assert(modelMap.has('coding-auto'), 'coding-auto model listed');
  assert(modelMap.get('coding-auto')._capabilities?.includes('chat'), 'coding-auto exposes chat capability');
  assert(modelMap.get('image-auto')._capabilities?.includes('image'), 'image-auto exposes image capability');

  const directChat = await post('/v1/chat/completions', { model: 'mock-b-chat', messages: [{ role: 'user', content: 'direct chat route' }] });
  assert(directChat._gateway.providerId === 'mock-b', 'mock-b-chat routes to mock-b');

  const fallbackChat = await post('/v1/chat/completions', { model: 'coding-auto', messages: [{ role: 'user', content: 'fallback chat route' }] });
  assert(fallbackChat.choices?.[0]?.message?.content, 'fallback chat response content exists');
  assert(['mock-a', 'mock-b'].includes(fallbackChat._gateway.providerId), 'coding-auto selects a healthy provider/account after mock-a rate limit');

  const chatMismatch = await postExpectStatus('/v1/chat/completions', { model: 'mock-a-image', messages: [{ role: 'user', content: 'wrong endpoint' }] }, 400);
  assert(/does not support/i.test(chatMismatch.error?.message || ''), 'image model rejects chat endpoint');

  const directImage = await post('/v1/images/generations', { model: 'mock-b-image', prompt: 'blue cat', response_format: 'b64_json' });
  assert(directImage.data?.[0]?.b64_json, 'direct image route returns base64 image');
  assert(directImage._gateway.providerId === 'mock-b', 'mock-b-image routes to mock-b');

  const fallbackImage = await post('/v1/images/generations', { model: 'image-auto', prompt: 'fallback image', response_format: 'b64_json' });
  assert(fallbackImage.data?.[0]?.b64_json, 'image fallback returns base64 image');
  assert(['mock-a', 'mock-b'].includes(fallbackImage._gateway.providerId), 'image-auto selects a healthy provider/account after mock-a rate limit');

  const imageMismatch = await postExpectStatus('/v1/images/generations', { model: 'coding-auto', prompt: 'wrong endpoint', response_format: 'b64_json' }, 400);
  assert(/does not support/i.test(imageMismatch.error?.message || ''), 'chat model rejects image endpoint');

  const responsesImage = await post('/v1/responses', {
    model: 'image-auto',
    input: 'golden fox portrait',
    stream: false,
    tools: [{ type: 'image_generation', size: '1024x1024' }],
  });
  assert(Array.isArray(responsesImage.output) && responsesImage.output.length > 0, 'responses endpoint returns output items');
  assert(['mock-a', 'mock-b'].includes(responsesImage._gateway.providerId), 'responses route selects a healthy provider/account after mock-a rate limit');

  const after = await get('/admin/snapshot', { authorization: 'Bearer local-admin-token' });
  assert(after.runtimeStates.length > 0, 'runtime state recorded');

  console.log(JSON.stringify({
    ok: true,
    health,
    capabilities: Object.fromEntries(Array.from(modelMap.entries()).map(([id, model]) => [id, model._capabilities || []])),
    directChatGateway: directChat._gateway,
    fallbackChatGateway: fallbackChat._gateway,
    directImageGateway: directImage._gateway,
    fallbackImageGateway: fallbackImage._gateway,
    responsesGateway: responsesImage._gateway,
    runtimeStates: after.runtimeStates,
  }, null, 2));
}

async function get(path, headers = {}) {
  const response = await fetch(base + path, { headers });
  const payload = await response.json();
  if (!response.ok) throw new Error(`${path} HTTP ${response.status}: ${JSON.stringify(payload)}`);
  return payload;
}

async function post(path, body) {
  const response = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const payload = await response.json();
  if (!response.ok) throw new Error(`${path} HTTP ${response.status}: ${JSON.stringify(payload)}`);
  return payload;
}

async function postExpectStatus(path, body, expectedStatus) {
  const response = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const payload = await response.json();
  if (response.status !== expectedStatus) {
    throw new Error(`${path} expected HTTP ${expectedStatus}, got ${response.status}: ${JSON.stringify(payload)}`);
  }
  return payload;
}

function assert(value, message) {
  if (!value) throw new Error(`assert failed: ${message}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
