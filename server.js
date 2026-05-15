const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();

const server = http.createServer(app);

const io = new Server(server,{
    cors:{
        origin:"*"
    }
});

let players = [];

let drawnNumbers = [];

let gameStarted = false;

let gameInterval = null;

function generateNumber(){

    let number;

    do{

        number =
        Math.floor(Math.random()*75)+1;

    }while(drawnNumbers.includes(number));

    drawnNumbers.push(number);

    return number;

}

function startCountdown(){

    let sec = 10;

    const countdown =
    setInterval(()=>{

        io.emit("countdown",sec);

        sec--;

        if(sec < 0){

            clearInterval(countdown);

            startGame();

        }

    },1000);

}

function startGame(){

    gameStarted = true;

    gameInterval =
    setInterval(()=>{

        if(drawnNumbers.length >= 75){

            clearInterval(gameInterval);

            return;

        }

        const number = generateNumber();

        io.emit("new-number",number);

    },4500);

}

function resetGame(){

    clearInterval(gameInterval);

    players = [];

    drawnNumbers = [];

    gameStarted = false;

    io.emit("new-game");

}

io.on("connection",(socket)=>{

    console.log("Player Connected");

    socket.on("join-game",(player)=>{

        players.push({

            id:socket.id,
            ...player

        });

        io.emit("player-count",players.length);

        if(players.length >= 2 && !gameStarted){

            startCountdown();

        }

    });

    socket.on("claim-bingo",(data)=>{

        if(!gameStarted) return;

        clearInterval(gameInterval);

        io.emit("winner",data);

        setTimeout(()=>{

            resetGame();

        },8000);

    });

    socket.on("disconnect",()=>{

        players =
        players.filter(p=>p.id !== socket.id);

        io.emit("player-count",players.length);

        console.log("Disconnected");

    });

});

server.listen(3000,()=>{

    console.log("Server Running");

});