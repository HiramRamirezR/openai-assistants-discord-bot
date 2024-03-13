const { Client, GatewayIntentBits } = require('discord.js');
const { OpenAI } = require("openai");
require("dotenv").config();

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
});

// Discord Client
const client = new Client({
  intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

const sleep = (ms) => {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// When discord bot has started up
client.once('ready', () => {
    console.log('Bot is ready!');
});

const threadMap = {};

const getOpenAiThreadId = (discordThreadId) => {
    // Replace this in-memory implementation with a database (e.g. DynamoDB, Firestore, Redis)
    return threadMap[discordThreadId];
}

const addThreadToMap = (discordThreadId, openAiThreadId) => {
    threadMap[discordThreadId] = openAiThreadId;
}

const terminalStates = ["cancelled", "failed", "completed", "expired"];

const statusCheckLoop = async (openAiThreadId, runId) => {
    const run = await openai.beta.threads.runs.retrieve(
        openAiThreadId,
        runId
    );

    if(terminalStates.indexOf(run.status) < 0){
        await sleep(1000);
        console.log("Sleeping...");
        console.log(`Run status: ${run.status}`);
        return statusCheckLoop(openAiThreadId, runId);
    }

    console.dir(run, { depth: null, colors: true });
    return run.status;
}

const addMessage = (threadId, content) => {
    return openai.beta.threads.messages.create(
        threadId,
        { role: "user", content }
    )
}

// This event will run every time a message is received
client.on('messageCreate', async message => {
    if (message.system) return;
    if (message.author.bot || !message.content || message.content === '') return; //Ignore bot messages

    // Manejar la solicitud de manera asíncrona
    handleMessage(message);
});

const handleMessage = async (message) => {
    try {
        console.log(message.content);
        console.log('ThreadMap:', JSON.stringify(threadMap, null, 2));

        const discordThreadId = message.channel.id;
        let openAiThreadId = getOpenAiThreadId(discordThreadId);
        let messagesLoaded = false;

        if(!openAiThreadId){
            const thread = await openai.beta.threads.create();
            openAiThreadId = thread.id;
            addThreadToMap(discordThreadId, openAiThreadId);

            if(message.channel.isThread()){
                //Gather all thread messages to fill out the OpenAI thread since we haven't seen this one yet
                const starterMsg = await message.channel.fetchStarterMessage();
                const otherMessagesRaw = await message.channel.messages.fetch();
                const otherMessages = Array.from(otherMessagesRaw.values())
                    .map(msg => msg.content)
                    .reverse(); //oldest first

                const messages = [starterMsg.content, ...otherMessages]
                    .filter(msg => !!msg && msg !== '')

                // console.log(messages);
                await Promise.all(messages.map(msg => addMessage(openAiThreadId, msg)));
                messagesLoaded = true;
            }
        }

        if(!messagesLoaded){ //If this is for a thread, assume msg was loaded via .fetch() earlier
            await addMessage(openAiThreadId, message.content);
        }

        // Procesar la solicitud de manera asíncrona
        const response = await processRequest(openAiThreadId, message.content);

        // Enviar la respuesta
        message.reply(response);
    } catch (error) {
        console.error('Error al procesar la solicitud:', error);
        // Manejar el error de manera adecuada
    }
}

const processRequest = async (openAiThreadId, messageContent) => {
    const run = await openai.beta.threads.runs.create(
        openAiThreadId,
        { assistant_id: process.env.ASSISTANT_ID }
    )

    const status = await statusCheckLoop(openAiThreadId, run.id);
    const messages = await openai.beta.threads.messages.list(openAiThreadId);
    let response = messages.data[0].content[0].text.value;
    response = response.substring(0, 1000) //Discord msg length limit
    console.log(response);

    return response;
}

// Evento que se activa cuando se actualiza un hilo
client.on('threadUpdate', (oldThread, newThread) => {
    // Verifica si el nombre del hilo ha cambiado
    if (oldThread.name !== newThread.name) {
        // Obtiene el ID del hilo de Discord
        const discordThreadId = oldThread.id;
        
        // Busca el ID del hilo de OpenAI en el threadMap
        const openAiThreadId = getOpenAiThreadId(discordThreadId);
        
        // Si el hilo existe en el threadMap, actualiza su ID de OpenAI
        if (openAiThreadId) {
            // Elimina la entrada antigua del threadMap
            delete threadMap[discordThreadId];
            
            // Crea una nueva entrada con el nuevo nombre del hilo
            threadMap[newThread.id] = openAiThreadId;
        }
    }
});

// Authenticate Discord
client.login(process.env.DISCORD_TOKEN);