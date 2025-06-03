require('dotenv').config();
const express = require('express');
const hbs = require('hbs');
const path = require('path');
const admin = require('firebase-admin');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const winston = require('winston');

// Initialize Express app
const app = express();

// Logger setup
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.File({ filename: 'error.log', level: 'error' }),
    new winston.transports.File({ filename: 'combined.log' }),
    new winston.transports.Console()
  ]
});

// Firebase setup
const base64String = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64;
if (!base64String) {
  logger.error('FIREBASE_SERVICE_ACCOUNT_BASE64 not set');
  process.exit(1);
}
try {
  const decodedString = Buffer.from(base64String, 'base64').toString('utf-8');
  const serviceAccount = JSON.parse(decodedString);
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
  logger.info('Firebase Admin initialized');
} catch (error) {
  logger.error(`Error initializing Firebase: ${error.message}`);
  process.exit(1);
}

const db = admin.firestore();

// Middleware
app.set('view engine', 'hbs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(helmet({ contentSecurityPolicy: false }));
app.use(rateLimit({ windowMs: 15 * 60 * 1000, max: 100 }));

// Firebase client config endpoint
app.get('/config', (req, res) => {
  res.json({
    apiKey: process.env.FIREBASE_API_KEY,
    authDomain: process.env.FIREBASE_AUTH_DOMAIN,
    projectId: process.env.FIREBASE_PROJECT_ID,
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
    messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID,
    appId: process.env.FIREBASE_APP_ID
  });
});

// Routes
app.get('/', (req, res) => {
  res.render('index', { title: 'Debate Trainer AI' });
});

app.get('/select-ai', (req, res) => {
  res.render('select-ai', { title: 'Select AI Personality' });
});

app.get('/debate-battle', (req, res) => {
  res.render('debate-battle', { aiResponse: '', debateHistory: [], title: 'Debate Battle' });
});

app.get('/debate-summary', (req, res) => {
  res.render('debate-summary', {
    grade: 'N/A',
    gradeDescription: 'No debate completed',
    debateHistory: [],
    improvementTips: [],
    title: 'Debate Summary'
  });
});

// Signup route
app.post('/signup', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password required' });
    }
    const userRecord = await admin.auth().createUser({ email, password });
    logger.info(`User created: ${userRecord.uid}`);
    res.status(201).json({ message: `User created: ${userRecord.uid}` });
  } catch (error) {
    logger.error(`Error creating user: ${error.message}`);
    res.status(400).json({ error: error.message });
  }
});

// Debate API endpoints
app.post('/api/debate/start', async (req, res) => {
  try {
    const { topic, personality, userId } = req.body;
    if (!topic || !personality || !userId) {
      return res.status(400).json({ error: 'Topic, personality, and userId required' });
    }
    const initialResponse = generateAIResponse(topic, personality, 1, '');
    const debateRef = db.collection('debates').doc();
    await debateRef.set({
      userId,
      topic,
      personality,
      history: [{ speaker: 'AI', argument: initialResponse, timestamp: new Date().toISOString() }],
      round: 1,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
    res.status(200).json({ aiResponse: initialResponse, debateId: debateRef.id });
  } catch (err) {
    logger.error(`Error starting debate: ${err.message}`);
    res.status(500).json({ error: 'Failed to start debate' });
  }
});

app.post('/api/debate/respond', async (req, res) => {
  try {
    const { debateId, userArgument, userId } = req.body;
    if (!debateId || !userArgument || !userId) {
      return res.status(400).json({ error: 'Debate ID, argument, and userId required' });
    }
    const debateRef = db.collection('debates').doc(debateId);
    const debate = await debateRef.get();
    if (!debate.exists || debate.data().userId !== userId) {
      return res.status(403).json({ error: 'Invalid debate or unauthorized' });
    }
    const { topic, personality, round, history } = debate.data();
    const newRound = round + 1;
    const aiResponse = generateAIResponse(topic, personality, newRound, userArgument);
    const outOfArguments = newRound > 3;
    history.push({ speaker: 'User', argument: userArgument, timestamp: new Date().toISOString() });
    if (!outOfArguments) {
      history.push({ speaker: 'AI', argument: aiResponse, timestamp: new Date().toISOString() });
    }
    await debateRef.update({ history, round: newRound });
    if (outOfArguments) {
      const { grade, gradeDescription, improvementTips } = evaluateDebate(history);
      await debateRef.update({ grade, gradeDescription, improvementTips, ended: true });
      return res.status(200).json({ ended: true, endMessage: 'Debate concluded!', grade, gradeDescription, improvementTips });
    }
    res.status(200).json({ aiResponse, evaluation: evaluateArgument(userArgument), outOfArguments });
  } catch (err) {
    logger.error(`Error processing debate response: ${err.message}`);
    res.status(500).json({ error: 'Failed to process response' });
  }
});

app.post('/api/debate/give-up', async (req, res) => {
  try {
    const { debateId, userId } = req.body;
    if (!debateId || !userId) {
      return res.status(400).json({ error: 'Debate ID and userId required' });
    }
    const debateRef = db.collection('debates').doc(debateId);
    const debate = await debateRef.get();
    if (!debate.exists || debate.data().userId !== userId) {
      return res.status(403).json({ error: 'Invalid debate or unauthorized' });
    }
    const { history } = debate.data();
    const { grade, gradeDescription, improvementTips } = evaluateDebate(history);
    await debateRef.update({ grade, gradeDescription, improvementTips, ended: true });
    res.status(200).json({ endMessage: 'You gave up. Check your summary.', grade, gradeDescription, improvementTips });
  } catch (err) {
    logger.error(`Error processing give-up: ${err.message}`);
    res.status(500).json({ error: 'Failed to process give-up' });
  }
});

app.get('/api/debate/summary/:debateId', async (req, res) => {
  try {
    const { debateId } = req.params;
    const { userId } = req.query;
    if (!userId) {
      return res.status(400).json({ error: 'userId required' });
    }
    const debateRef = db.collection('debates').doc(debateId);
    const debate = await debateRef.get();
    if (!debate.exists || debate.data().userId !== userId) {
      return res.status(403).json({ error: 'Invalid debate or unauthorized' });
    }
    const { history, grade, gradeDescription, improvementTips } = debate.data();
    res.render('debate-summary', { grade, gradeDescription, debateHistory: history, improvementTips, title: 'Debate Summary' });
  } catch (err) {
    logger.error(`Error fetching summary: ${err.message}`);
    res.status(500).json({ error: 'Failed to fetch summary' });
  }
});

// AI Response Logic
function generateAIResponse(topic, personality, round, userMessage) {
  const responses = {
    centrist: [
      `Let’s discuss "${topic}" with balance. Both sides have valid points—proponents might say it fosters stability, while critics argue it lacks ambition. What’s your perspective?`,
      `Your point, "${userMessage}", is interesting. A balanced view suggests ${topic} could benefit from compromise. Studies show moderate policies often yield sustainable results. How do you respond?`,
      `You said "${userMessage}". Extremes on ${topic} often lead to conflict. Historical compromises, like the U.S. Constitution’s checks, show middle-ground success. Why prefer your stance?`,
      `With "${userMessage}", we’ve covered ${topic} well. As a centrist, I’m out of arguments—let’s evaluate your performance!`
    ],
    leftist: [
      `On "${topic}", I prioritize equity. If ${topic} harms marginalized groups, we must act. Data shows 30% of affected populations face disparities. What’s your stance?`,
      `Your argument, "${userMessage}", raises points, but equity demands more. Policies on ${topic} often widen gaps—recent studies confirm this. How do you counter?`,
      `Regarding "${userMessage}", systemic reform for ${topic} is critical. The Civil Rights Movement shows collective action drives change. What evidence supports your view?`,
      `Your case, "${userMessage}", doesn’t shift my focus on ${topic}. I’m out of arguments—let’s see your score!`
    ],
    'far-leftist': [
      `I reject aspects of "${topic}" that prop up oppressive systems. It exploits the working class—Marxist critiques highlight this. Prove it doesn’t!`,
      `Your point, "${userMessage}", sidesteps systemic issues in ${topic}. Labor movements of the 1900s show radical change is needed. Justify your position!`,
      `With "${userMessage}", you miss the need to dismantle ${topic}’s structures. The 1917 Russian Revolution proves bold action works. Where’s your counter-evidence?`,
      `Your argument, "${userMessage}", doesn’t sway my stance on ${topic}. I’m out—let’s evaluate!`
    ],
    'right-winger': [
      `For "${topic}", I value tradition. If ${topic} disrupts norms, it risks stability. Post-WWI shifts caused chaos. What’s your justification?`,
      `You said "${userMessage}". Individual responsibility trumps collective shifts for ${topic}. Free-market data supports this. How do you rebut?`,
      `Your point, "${userMessage}", overlooks tradition’s role in ${topic}. The 1980s Reagan era showed conservative values drive prosperity. Where’s your evidence?`,
      `With "${userMessage}", my stance on ${topic} holds. I’m out of arguments—let’s see your grade!`
    ],
    'far-right-winger': [
      `I oppose progressive views on "${topic}"—they threaten identity. If ${topic} dilutes culture, Rome’s fall warns us. Prove it’s safe!`,
      `Your argument, "${userMessage}", ignores heritage in ${topic}. Strong nations preserve identity—1920s policies show this. Defend your stance!`,
      `With "${userMessage}", you miss ${topic}’s threat to values. Nationalism’s rise in the 2010s proves borders matter. Where’s your proof?`,
      `Your point, "${userMessage}", doesn’t change my stance on ${topic}. I’m out—let’s grade your debate!`
    ]
  };
  return responses[personality][Math.min(round - 1, 3)];
}

// Argument Evaluation
function evaluateArgument(message) {
  const evaluation = { logicalTrap: false, emotional: false, evidence: false };
  const messageLower = message.toLowerCase();
  if (messageLower.includes('because i feel') || messageLower.includes('i believe') || messageLower.includes('it’s unfair')) {
    evaluation.emotional = true;
  }
  if (messageLower.includes('for example') || messageLower.includes('statistics') || messageLower.includes('study')) {
    evaluation.evidence = true;
  }
  if (messageLower.includes('all') || messageLower.includes('never') || messageLower.includes('always')) {
    evaluation.logicalTrap = true;
  }
  return evaluation;
}

// Debate Evaluation
function evaluateDebate(history) {
  let score = 0;
  const userArguments = history.filter(h => h.speaker === 'User').map(h => h.argument);
  userArguments.forEach(arg => {
    const eval = evaluateArgument(arg);
    if (eval.evidence) score += 3;
    if (!eval.emotional) score += 2;
    if (!eval.logicalTrap) score += 2;
  });
  let grade, gradeDescription, improvementTips;
  if (score >= 15) {
    grade = 'A';
    gradeDescription = 'Outstanding! Your arguments were logical and evidence-based.';
    improvementTips = ['Continue using strong evidence.', 'Address counterarguments for depth.'];
  } else if (score >= 10) {
    grade = 'B';
    gradeDescription = 'Solid effort! More evidence could elevate your arguments.';
    improvementTips = ['Add specific examples or data.', 'Reduce emotional appeals.'];
  } else if (score >= 5) {
    grade = 'C';
    gradeDescription = 'Fair attempt, but arguments need substance.';
    improvementTips = ['Incorporate statistics or examples.', 'Avoid words like "always" or "never."'];
  } else {
    grade = 'D';
    gradeDescription = 'Needs work. Arguments lacked evidence or were too emotional.';
    improvementTips = ['Focus on factual arguments.', 'Learn about logical fallacies.'];
  }
  return { grade, gradeDescription, improvementTips };
}

// Error handling middleware
app.use((err, req, res, next) => {
  logger.error(`Unexpected error: ${err.message}`);
  res.status(500).json({ error: 'Internal Server Error' });
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  logger.info(`Server running on port ${PORT}`);
});

// Handle uncaught exceptions and rejections
process.on('uncaughtException', (err) => {
  logger.error(`Uncaught Exception: ${err.message}`);
  process.exit(1);
});
process.on('unhandledRejection', (reason, promise) => {
  logger.error(`Unhandled Rejection at: ${promise}, reason: ${reason}`);
  process.exit(1);
});
