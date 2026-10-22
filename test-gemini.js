require('dotenv').config();

const API_KEY = process.env.GEMINI_API_KEY;

if (!API_KEY) {
  console.error('❌ No hay GEMINI_API_KEY en .env');
  process.exit(1);
}

console.log('🔑 API Key:', API_KEY.substring(0, 10) + '...');

// Listar modelos disponibles
async function listModels() {
  const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${API_KEY}`;
  
  try {
    const response = await fetch(url);
    const data = await response.json();
    
    if (!response.ok) {
      console.error('❌ Error al listar modelos:', data.error?.message);
      return;
    }
    
    console.log('\n✅ Modelos disponibles en tu API key:');
    data.models.forEach(model => {
      console.log(`  - ${model.name}`);
    });
  } catch (error) {
    console.error('❌ Error:', error.message);
  }
}

// Probar un modelo específico
async function testModel(modelName) {
  console.log(`\n🧪 Probando modelo: ${modelName}`);
  
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${API_KEY}`;
  
  const body = {
    contents: [{ role: 'user', parts: [{ text: 'Hola' }] }],
    generationConfig: { temperature: 0.7, maxOutputTokens: 100 }
  };
  
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    
    const data = await response.json();
    
    if (!response.ok) {
      console.error(`❌ Error ${response.status}:`, data.error?.message);
      return false;
    }
    
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    console.log(`✅ Respuesta: ${text}`);
    return true;
  } catch (error) {
    console.error('❌ Error:', error.message);
    return false;
  }
}

async function main() {
  await listModels();
  
  // Probar diferentes modelos
  const models = [
    'gemini-pro',
    'gemini-1.0-pro',
    'gemini-1.5-pro',
    'gemini-1.5-flash',
    'gemini-2.0-flash'
  ];
  
  for (const model of models) {
    const success = await testModel(model);
    if (success) {
      console.log(`\n🎉 ¡Este modelo funciona! Usa: ${model}`);
      break;
    }
  }
}

main();