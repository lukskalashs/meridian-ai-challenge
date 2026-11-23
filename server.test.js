'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Readable } = require('node:stream');
const test = require('node:test');
const {
  buildStructuredOutputSchema,
  buildMessages,
  generateProposal,
  handleWhatsAppWebhook,
  hasValidTwilioSignature,
  removeEmptyValues,
  processWhatsAppMessage,
  transcribeTwilioMedia,
  transcribeAudio,
  twilioSignature,
  validateAgainstSchema,
  validateExtraction
} = require('./server');

const models = [
  { id:'balanced', label:'Balanced', portfolioName:'Meridian Balanced Portfolio', scope:'public' },
  { id:'global-growth', label:'Global Growth', portfolioName:'Meridian Global Growth Portfolio', scope:'public' },
  { id:'income', label:'Income', portfolioName:'Meridian Income Portfolio', scope:'public' }
];

test('strict proposal schema contains proposal, missingInformation, and reviewNotes', () => {
  const schema = buildStructuredOutputSchema(models, 'auto');
  assert.deepEqual(schema.required, ['proposal','missingInformation','reviewNotes']);
  assert.equal(schema.additionalProperties, false);
  assert.equal('about' in schema.properties.proposal.properties, false);
  assert.equal(schema.properties.proposal.additionalProperties, false);
});

test('fixed strict schema exposes the full extraction contract and live model choices', () => {
  const proposal = buildStructuredOutputSchema(models, 'auto').properties.proposal.properties;
  assert.deepEqual(Object.keys(proposal).slice(0, 4), [
    'clientName','introGreetTo','applyModel','needs'
  ]);
  assert.equal('clientName' in proposal, true);
  assert.equal('fees' in proposal, true);
  assert.equal('goalAssessment' in proposal, true);
  assert.equal('objective' in proposal, true);
  assert.equal('financialPlanner' in proposal, true);
  assert.equal(
    proposal.objective.anyOf.find((candidate) => candidate.type === 'object')
      .properties.riskProfileCategory.anyOf.find((candidate) => candidate.type === 'string')
      .enum.includes('Aggressive'),
    true
  );
  const goalAssessment = proposal.goalAssessment.anyOf.find((candidate) => candidate.type === 'object');
  assert.equal(Object.keys(goalAssessment.properties)[0], 'clientType');
});

test('extraction instructions map key facts to the documented fields', () => {
  const prompt = buildMessages('Sithole Family Trust', models, 'auto')[0].content;
  assert.match(prompt, /goalAssessment\.clientType, never to goalAssessment\.wrapper/);
  assert.match(prompt, /goalAssessment\.keyFigures\.totalInvestment/);
  assert.match(prompt, /financialPlanner/);
  assert.match(prompt, /Use applyModel for a selected model/);
  assert.match(prompt, /Always write a concise, faithful needs summary in needs/);
  assert.match(prompt, /Check investment amount, income amount\/frequency, and investment horizon separately/);
  assert.match(prompt, /Never turn vague wording such as "a few million" into a numeric amount/);
  assert.match(prompt, /Never copy or infer client facts, fees, horizons, returns, names, or other values from the reference examples/);
  assert.match(prompt, /If they state an investment horizon, always include it in objective\.investmentHorizon/);
  assert.match(prompt, /do not invent a category/);
});

test('all supplied note and expected JSON pairs are sent as extraction examples', () => {
  const directory = path.join(__dirname, 'sample-inputs');
  const messages = buildMessages('Current test notes.', models, 'auto');
  const expectedFiles = fs.readdirSync(directory)
    .filter((name) => name.endsWith('-expected.json'))
    .sort();
  assert.equal(expectedFiles.length, 4);

  expectedFiles.forEach((expectedName, index) => {
    const samplePrefix = expectedName.slice(0, 2);
    const noteName = fs.readdirSync(directory).find((name) =>
      name.startsWith(`${samplePrefix}-`) && name.endsWith('.txt')
    );
    const expected = JSON.parse(fs.readFileSync(path.join(directory, expectedName), 'utf8'));
    const note = fs.readFileSync(path.join(directory, noteName), 'utf8');
    const noteMessage = JSON.parse(messages[1 + index * 2].content);
    const expectedMessage = JSON.parse(messages[2 + index * 2].content);
    assert.equal(noteMessage.referenceNotes, note, expectedName);
    assert.deepEqual(expectedMessage.proposal, expected, expectedName);
  });
});

test('all supplied expected proposals validate', () => {
  const root = __dirname;
  for (const name of fs.readdirSync(path.join(root,'sample-inputs')).filter((n)=>n.endsWith('-expected.json'))) {
    const proposal = JSON.parse(fs.readFileSync(path.join(root,'sample-inputs',name),'utf8'));
    assert.equal(validateAgainstSchema(proposal, require('./schema.json')), null, name);
  }
});

test('manual model selection overrides AI model choice', () => {
  const result = validateExtraction({
    proposal:{applyModel:'balanced',clientName:'Test Client'},
    missingInformation:[],
    reviewNotes:[]
  }, models, 'income');
  assert.equal(result.proposal.applyModel,'income');
});

test('normalizes model aliases to a single top-level applyModel field', () => {
  const result = validateExtraction({
    proposal:{
      clientName:'The Sithole Family Trust',
      strategy:{model:'global-growth',currency:'USD'},
      goalAssessment:{clientType:'Trust',portfolioModel:'global-growth'}
    },
    missingInformation:[],
    reviewNotes:[]
  }, models, 'auto');
  assert.equal(result.proposal.applyModel,'global-growth');
  assert.equal('model' in result.proposal.strategy,false);
  assert.equal('portfolioModel' in result.proposal.goalAssessment,false);
});

test('rejects unsupported top-level proposal fields', () => {
  assert.throws(() => validateExtraction({
    proposal:{investmentAmount:'1000000'},
    missingInformation:[],
    reviewNotes:[]
  }, models, 'auto'), /unsupported proposal field/);
});

test('normalizes greeting aliases', () => {
  const result = validateExtraction({
    proposal:{introGreetTo:'financial adviser'},
    missingInformation:[],
    reviewNotes:[]
  }, models, 'auto');
  assert.equal(result.proposal.introGreetTo,'advisor');
});

test('removes empty values but preserves proposal numbers and strings', () => {
  assert.deepEqual(removeEmptyValues({
    clientName:'Test',
    goalAssessment:{keyFigures:{totalInvestment:'1000000',incomeValue:''}},
    replacements:{isReplacement:false,details:''}
  }), {
    clientName:'Test',
    goalAssessment:{keyFigures:{totalInvestment:'1000000'}},
    replacements:{isReplacement:false}
  });
});

test('live API mock uses one request with the fixed strict proposal schema', async () => {
  const originalFetch = global.fetch;
  const originalKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY='test-key';
  let request;
  let callCount = 0;
  global.fetch=async(_url,options)=>{
    callCount += 1;
    request=JSON.parse(options.body);
    return new Response(JSON.stringify({
      choices:[{message:{content:JSON.stringify({
        proposal:{clientName:'Test Client',applyModel:'balanced',goalAssessment:{keyFigures:{totalInvestment:'1000000'}}},
        missingInformation:['Confirm the investment amount.'],
        reviewNotes:[]
      })}}]
    }),{status:200,headers:{'Content-Type':'application/json'}});
  };
  try {
    const result=await generateProposal({notes:'Test client has about R1 million.',models,modelOverride:'auto'});
    assert.equal(result.proposal.clientName,'Test Client');
    assert.equal(callCount,1);
    assert.equal(request.response_format.type,'json_schema');
    assert.equal(request.response_format.json_schema.strict,true);
    assert.equal(
      'fees' in request.response_format.json_schema.schema.properties.proposal.properties,
      true
    );
  } finally {
    global.fetch=originalFetch;
    if(originalKey===undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY=originalKey;
  }
});

test('audio transcription uses the configured OpenAI endpoint and returns reviewable text', async () => {
  const originalFetch = global.fetch;
  const originalKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'test-key';
  let requestUrl;
  let requestOptions;
  global.fetch = async (url, options) => {
    requestUrl = url;
    requestOptions = options;
    return new Response(JSON.stringify({ text: 'Client wants income and offshore growth.' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  };
  try {
    const result = await transcribeAudio({
      fileName: 'meeting-note.webm',
      mimeType: 'audio/webm',
      audioBase64: Buffer.from('fake audio bytes').toString('base64')
    });
    assert.equal(result.text, 'Client wants income and offshore growth.');
    assert.equal(requestUrl, 'https://api.openai.com/v1/audio/transcriptions');
    assert.equal(requestOptions.headers.Authorization, 'Bearer test-key');
    assert.equal(requestOptions.body.get('model'), 'whisper-1');
    assert.equal(requestOptions.body.get('file').name, 'meeting-note.webm');
    assert.equal(await requestOptions.body.get('file').text(), 'fake audio bytes');
  } finally {
    global.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalKey;
  }
});

test('audio transcription rejects unsupported files before calling OpenAI', async () => {
  await assert.rejects(
    transcribeAudio({ fileName: 'notes.txt', audioBase64: Buffer.from('not audio').toString('base64') }),
    /supported format/
  );
  await assert.rejects(
    transcribeAudio({ fileName: 'notes.mp3', audioBase64: 'not-base64' }),
    /audio data is invalid/
  );
});

test('Twilio voice media uses API key credentials before OpenAI transcription', async () => {
  const originalFetch = global.fetch;
  const originalKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'test-openai-key';
  const requests = [];
  global.fetch = async (url, options) => {
    requests.push({ url: String(url), options });
    if (String(url).startsWith('https://api.twilio.com/')) {
      return new Response(Buffer.from('fake ogg bytes'), {
        status: 200,
        headers: { 'Content-Length': String(Buffer.byteLength('fake ogg bytes')) }
      });
    }
    return new Response(JSON.stringify({ text: 'Transcribed WhatsApp voice note.' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  };
  try {
    const result = await transcribeTwilioMedia(
      'https://api.twilio.com/2010-04-01/Accounts/AC123/Messages/SM123/Media/ME123',
      'audio/ogg; codecs=opus',
      {
        accountSid: 'AC123',
        authToken: 'test-auth-token',
        apiKeySid: 'SK123',
        apiKeySecret: 'test-api-secret'
      }
    );
    assert.equal(result.text, 'Transcribed WhatsApp voice note.');
    assert.equal(requests.length, 2);
    assert.equal(
      requests[0].options.headers.Authorization,
      `Basic ${Buffer.from('SK123:test-api-secret').toString('base64')}`
    );
    assert.equal(requests[1].url, 'https://api.openai.com/v1/audio/transcriptions');
  } finally {
    global.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalKey;
  }
});

test('Twilio media download failures report provider error codes without leaking details', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => new Response(JSON.stringify({
    code: 20003,
    message: 'Sensitive account detail should not be logged.'
  }), { status: 401, headers: { 'Content-Type': 'application/json' } });
  try {
    await assert.rejects(
      transcribeTwilioMedia(
        'https://api.twilio.com/2010-04-01/Accounts/AC123/Messages/SM123/Media/ME123',
        'audio/ogg',
        { accountSid: 'AC123', apiKeySid: 'SK123', apiKeySecret: 'test-secret' }
      ),
      (error) => {
        assert.match(error.message, /HTTP 401, Twilio code 20003/);
        assert.doesNotMatch(error.message, /Sensitive account detail/);
        return true;
      }
    );
  } finally {
    global.fetch = originalFetch;
  }
});

test('Twilio webhook signatures include the configured URL and sorted form fields', () => {
  const url = 'https://example.ngrok.app/api/whatsapp/inbound';
  const token = 'twilio-test-token';
  const parameters = new URLSearchParams([
    ['Body', 'Test notes'],
    ['From', 'whatsapp:+15551234567'],
    ['AccountSid', 'AC123']
  ]);
  const signature = twilioSignature(url, parameters, token);
  assert.equal(hasValidTwilioSignature(url, parameters, token, signature), true);
  parameters.set('Body', 'Changed notes');
  assert.equal(hasValidTwilioSignature(url, parameters, token, signature), false);
});

test('WhatsApp text notes reuse proposal extraction for local review', async () => {
  const originalFetch = global.fetch;
  const originalKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'test-key';
  const requests = [];
  global.fetch = async (url, options) => {
    requests.push({ url, options });
    return new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({
        proposal: { clientName: 'Test Client', applyModel: 'balanced' },
        missingInformation: ['Confirm the investment horizon.'],
        reviewNotes: []
      }) } }]
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  try {
    const result = await processWhatsAppMessage(new URLSearchParams([
      ['From', 'whatsapp:+15551234567'],
      ['Body', 'Test client wants an income proposal.'],
      ['NumMedia', '0']
    ]), {
      accountSid: 'AC123',
      authToken: 'test-token'
    });
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, 'https://api.openai.com/v1/chat/completions');
    assert.equal(result.proposal.clientName, 'Test Client');
    assert.deepEqual(result.missingInformation, ['Confirm the investment horizon.']);
  } finally {
    global.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalKey;
  }
});

test('Twilio webhook accepts inbound notes and runs extraction without outbound API sends', async () => {
  const originalFetch = global.fetch;
  const originalInfo = console.info;
  const envNames = [
    'OPENAI_API_KEY', 'TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN',
    'TWILIO_WEBHOOK_URL', 'WHATSAPP_ALLOWED_SENDERS'
  ];
  const originalEnv = Object.fromEntries(envNames.map((name) => [name, process.env[name]]));
  Object.assign(process.env, {
    OPENAI_API_KEY: 'test-openai-key',
    TWILIO_ACCOUNT_SID: 'AC123',
    TWILIO_AUTH_TOKEN: 'test-twilio-token',
    TWILIO_WEBHOOK_URL: 'https://example.ngrok.app/api/whatsapp/inbound',
    WHATSAPP_ALLOWED_SENDERS: 'whatsapp:+15551234567'
  });
  const requests = [];
  const logs = [];
  global.fetch = async (url, options) => {
    requests.push({ url, options });
    return new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({
        proposal: { clientName: 'Test Client', applyModel: 'balanced' },
        missingInformation: ['Confirm the horizon.'],
        reviewNotes: []
      }) } }]
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  console.info = (...values) => logs.push(values.join(' '));
  try {
    const parameters = new URLSearchParams([
      ['AccountSid', 'AC123'],
      ['From', 'whatsapp:+15551234567'],
      ['Body', 'Test client wants an investment proposal.'],
      ['NumMedia', '0']
    ]);
    const request = Readable.from([Buffer.from(parameters.toString())]);
    request.headers = {
      'content-type': 'application/x-www-form-urlencoded',
      'x-twilio-signature': twilioSignature(
        process.env.TWILIO_WEBHOOK_URL,
        parameters,
        process.env.TWILIO_AUTH_TOKEN
      )
    };
    const response = {
      writeHead(status, headers) { this.statusCode = status; this.headers = headers; },
      end(body) { this.body = body; }
    };
    await handleWhatsAppWebhook(request, response);
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['Content-Type'], 'text/xml; charset=utf-8');
    assert.equal(response.body, '<Response/>');

    for (let attempt = 0; attempt < 100 && !logs.some((line) => line.includes('WhatsApp proposal generated')); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, 'https://api.openai.com/v1/chat/completions');
    assert.match(logs.join('\n'), /"clientName": "Test Client"/);
    assert.match(logs.join('\n'), /"Confirm the horizon\."/);
  } finally {
    global.fetch = originalFetch;
    console.info = originalInfo;
    for (const [name, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});
