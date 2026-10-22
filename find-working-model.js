require('dotenv').config();

const API_KEY = process.env.GEMINI_API_KEY;

if (!API_KEY) {
  console.error('❌ No hay GEMINI_API_KEY en .env');
  process.exit(1);
}

console.log('🔑 API Key:', API_KEY.substring(0, 15) + '...');
console.log('');

async function testGenerateContent(modelName) {
  const url = `https://generativelanguage.googleapis.com/v1/models/${modelName}:generateContent?key=${API_KEY}`;
  
  const body = {
    contents: [{ role: 'user', parts: [{ text: 'Hola, responde con una palabra' }] }],
    generationConfig: { temperature: 0.7, maxOutputTokens: 50 }
  };

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    const data = await response.json();

    if (response.ok && data.candidates) {
      const text = data.candidates[0]?.content?.parts?.[0]?.text || '';
      console.log(`✅ ${modelName} → FUNCIONA!`);
      console.log(`   Respuesta: "${text}"`);
      return true;
    } else {
      const errorMsg = data.error?.message || `HTTP ${response.status}`;
      console.log(`❌ ${modelName} → ${errorMsg.substring(0, 100)}`);
      return false;
    }
  } catch (error) {
    console.log(`❌ ${modelName} → Error: ${error.message}`);
    return false;
  }
}

async function main() {
  console.log('🧪 Probando cada modelo con generateContent...\n');

  const models = [
    'gemini-3.8-flash',
    'gemini-3.7-flash',
    'gemini-3.6-flash',
    'gemini-3.5-flash',
    'gemini-3.5-flash-lite',
    'gemini-3.1-flash-lite',
    'gemini-2.5-flash',
    'gemini-2.5-flash-lite',
    'gemini-2.5-pro'
  ];

  let workingModel = null;

  for (const model of models) {
    console.log(`\n🔍 Probando: ${model}`);
    const success = await testGenerateContent(model);
    
    if (success && !workingModel) {
      workingModel = model;
      console.log(`\n🎉 ¡ENCONTRADO! El modelo que funciona es: ${model}`);
      console.log(`\n📝 Actualiza tu .env con:`);
      console.log(`   GEMINI_MODEL=${model}`);
      break;
    }

    // Esperar 2 segundos entre pruebas para no saturar
    await new Promise(resolve => setTimeout(resolve, 2000));
  }

  if (!workingModel) {
    console.log('\n❌ Ningún modelo funcionó con generateContent');
    console.log('💡 Posibles causas:');
    console.log('   - Tu API key no tiene permisos de generación');
    console.log('   - Necesitas habilitar "Generative Language API" en Google Cloud');
    console.log('   - Los modelos requieren un endpoint diferente');
  }
}

main();