require('dotenv').config();

const API_KEY = process.env.GEMINI_API_KEY;

if (!API_KEY || API_KEY === 'TU_API_KEY_AQUI') {
  console.error('❌ La GEMINI_API_KEY en tu .env está vacía o sin configurar.');
  process.exit(1);
}

console.log('🔑 Usando API Key que empieza con:', API_KEY.substring(0, 15) + '...');

const url = `https://generativelanguage.googleapis.com/v1/models?key=${API_KEY}`;

fetch(url)
  .then(res => res.json())
  .then(data => {
    if (data.error) {
      console.error('\n❌ ERROR DE GOOGLE:');
      console.error(data.error.message);
      console.log('\n💡 Solución: Revisa tu API Key o habilita la "Generative Language API" en Google Cloud Console.');
    } else if (data.models && data.models.length > 0) {
      console.log('\n✅ ¡Tu API Key funciona! Modelos disponibles:');
      data.models.forEach(m => {
        if (m.name.includes('flash') || m.name.includes('pro')) {
          console.log('  ->', m.name.replace('models/', ''));
        }
      });
    } else {
      console.log('\n⚠️ Tu API Key es válida, pero no devuelve ningún modelo.');
    }
  })
  .catch(err => {
    console.error('❌ Error de red:', err.message);
  });