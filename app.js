//dependencies
require('dotenv').config();
const express = require("express");
const cors = require("cors");
const cookieParser = require("cookie-parser");

//requires root
const authRoute = require('./routes/auth-routes');
const usersRoute = require('./routes/users-routes');

const app = express();
const corsOptions = {optionsSuccessStatus: 200, Credential:true, origin:process.env.URL,};

//middlewares
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(cors(corsOptions));
app.use(cookieParser());

//ROUTES
app.use('/', authRoute);
app.use('/', usersRoute);



app.listen(5000, () => {
  console.log("Server has started on port 5000");
});
