/*
  tagfinder.js: manage a tagfinder child process, sending it vahData and setParam messages, then
  emitting gotTag messages.
*/

function TagFinder(matron, prog, tagFiles, params) {
    this.matron             = matron;
    this.prog               = prog;
    this.tagFiles           = tagFiles;
    this.params             = params || [];
    this.noTagFile          = false; // used to print no-tag-file error once
    this.child              = null;
    this.quitting           = false;
    this.inDieHandler       = false;
    this.this_spawnChild    = this.spawnChild.bind(this);
    this.this_quit          = this.quit.bind(this);
    this.this_childDied     = this.childDied.bind(this);
    this.this_gotInput      = this.gotInput.bind(this);
    this.this_gotParamInput = this.gotParamInput.bind(this);
    this.this_gotOutput     = this.gotOutput.bind(this);
    matron.on("quit", this.this_quit);
};

TagFinder.prototype.ignore = function() {
    // for ignoring errors on child process stdio, since these just
    // precede death of the child process
};

TagFinder.prototype.start = function() {
    this.spawnChild();
};

TagFinder.prototype.quit = function() {
    if (this.child) {
        this.quitting = true;
        this.child.kill("SIGKILL");
    }
};

TagFinder.prototype.childDied = function(code, signal) {
    if (! this.inDieHandler) {
        this.inDieHandler = true;
        this.matron.removeListener("vahData", this.this_gotInput);
        this.matron.removeListener("setParam", this.this_gotParamInput);
        if (! this.quitting) {
            setTimeout(this.this_spawnChild, 5000);
        }
        this.inDieHandler = false;
        console.log("Tag finder died");
    }
};

TagFinder.prototype.spawnChild = function() {
    if (this.quitting)
        return;

    // see whether we can find a tag file
    this.matron.tagDBFile = null;
    for (let tf of this.tagFiles) {
        if (Fs.existsSync(tf)) {
            this.matron.tagDBFile = tf;
            break;
        }
    }
    
    // if we have no tag file, print an error once, and then sleep for a bit a retry
    if (! this.matron.tagDBFile) {
        if (! this.noTagFile) {
            console.log("No tag database for tag finder, looking at " + this.tagFiles.join(", "));
            this.noTagFile = true;
        }

        setTimeout(this.this_spawnChild, 10000);
        return;
    }
    this.noTagFile = false;

    // launch the tag finder process
    var p = this.params.concat("-c", "8", this.matron.tagDBFile);
    console.log("Starting ", this.prog, " ", p.join(" "));
    var child = ChildProcess.spawn(this.prog, p)
        .on("exit", this.this_childDied)
        .on("error", this.this_childDied);

    child.stdout.on("data", this.this_gotOutput);
    child.stdout.on("error", this.ignore);
    child.stdin.on("error", this.ignore);

    this.child = child;
    this.matron.on("vahData", this.this_gotInput);
    this.matron.on("setParam", this.this_gotParamInput);
};

TagFinder.prototype.gotInput = function(x) {
    try {
        this.child.stdin.write(x.toString());
    } catch(e) {};
};

TagFinder.prototype.gotParamInput = function(s) {
    if (s.par != '-m')
        return;
    try {
        this.child.stdin.write("S," + s.time + "," + s.port + "," + s.par + "," + s.val + "," + s.errCode + "," + s.err + "\n");
    } catch(e) {};
};

TagFinder.prototype.gotOutput = function(x) {
    this.matron.emit("gotTag", x.toString());
};

exports.TagFinder = TagFinder;
