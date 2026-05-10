require('dotenv').config();
const express = require('express');
const path    = require('path');
const app     = express();

app.use(express.static(path.join(__dirname, 'public')));

app.use('/mlb',        require('./routes/mlb'));
app.use('/odds',       require('./routes/odds'));
app.use('/weather',    require('./routes/weather'));
app.use('/savant',     require('./routes/savant'));
app.use('/fangraphs',  require('./routes/fangraphs'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`D-backs Predictor running on port ${PORT}`));
