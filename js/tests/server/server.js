( function () {

var http = require( 'http' ),
	express = require( 'express' ),
	sqlite = require( 'sqlite3' ),
	dbStack = [], dbFlag = false,
	db = new sqlite.Database( 'pages.db' ),

getTitle = function ( req, res ) {
	res.setHeader( 'Content-Type', 'text/plain; charset=UTF-8' );

	// Select pages that were not claimed in the last hour
	var cutOffTimestamp = Date.now() - 3600;
	db.serialize( function () {
		db.get( 'SELECT title FROM pages WHERE result IS NULL AND (claimed < ? or claimed is null) ORDER BY RANDOM() LIMIT 1', [cutOffTimestamp], function ( err, row ) {
			if ( err ) {
				console.log( err );
				res.send( 'Error! ' + err.toString(), 500 );
			} else if ( row ) {
				db.run( 'UPDATE pages SET claimed = ? WHERE title = ?', [ Date.now(), row.title ], function ( err ) {
					if ( err ) {
						console.log( err );
						res.send( 'Error! ' + err.toString(), 500 );
					} else {
						console.log( 'Dispatching ', row.title );
						res.send( row.title );
					}
				} );
			} else {
				res.send( 'no available titles that fit those constraints', 404 );
			}
		} );
	} );
},

recieveResults = function ( req, res ) {
	var clientName = req.params[0], title = decodeURIComponent( req.params[1] ), result = req.body.results,
		skipCount = result.match( /\<skipped/g ), failCount = result.match( /\<failure/g ), errorCount = result.match( /\<error/g );

	skipCount = skipCount ? skipCount.length - 1 : 0;
	failCount = failCount ? failCount.length - 1 : 0;
	errorCount = errorCount ? 1 : 0;

	console.log( 'Client sent back results.' );

	res.setHeader( 'Content-Type', 'text/plain; charset=UTF-8' );

	console.log( 'Updating database' );

	if ( errorCount > 0 && result.match( 'DoesNotExist' ) ) {
		console.log( 'DoesNotExist error get, skipping update.' );
		res.send( '', 200 );
	} else {
		db.run( 'UPDATE pages SET result = ?, skips = ?, fails = ?, errors = ?, client = ? WHERE title = ?',
			[ result, skipCount, failCount, errorCount, clientName, title ], function ( err ) {
			console.log( 'Updated.' );
			if ( err ) {
				res.send( err.toString(), 500 );
			} else {
				console.log( title, '-', skipCount, 'skips,', failCount, 'fails,', errorCount, 'errors.' );
				res.send( '', 200 );
			}
		} );
	}
},

statsWebInterface = function ( req, res ) {
	db.serialize( function () {
		db.get( 'SELECT * FROM ((SELECT count(*) FROM pages WHERE result IS NOT NULL) AS total,'
				+ '(SELECT count(*) FROM pages WHERE result IS NOT NULL AND errors = 0) AS noError,'
				+ '(SELECT count(*) FROM pages WHERE result IS NOT NULL AND errors = 0 AND fails = 0) AS noFail,'
				+ '(SELECT count(*) FROM pages WHERE result IS NOT NULL AND errors = 0 AND fails = 0 AND skips = 0) AS noSkip) AS temp', function ( err, row ) {
			if ( err ) {
				res.send( err.toString(), 500 );
			} else if ( row.length <= 0 ) {
				res.send( 'No entries found', 404 );
			} else {
				res.setHeader( 'Content-Type', 'text/html' );
				res.status( 200 );
				res.write( '<html><body>' );

				var tests = row['count(*)'],
					noErrors = Math.floor( ( row['count(*):1'] / row['count(*)'] ) * 100 ),
					syntacticDiffs = Math.floor( ( row['count(*):2'] / row['count(*)'] ) * 100 ),
					perfects = Math.floor( ( row['count(*):3'] / row['count(*)'] ) * 100 );


				res.write( '<p>We have run roundtrip-tests on <b>'
						   + tests
						   + '</b> articles, of which <ul><li><b>'
						   + noErrors
						   + '%</b> parsed without crashes, </li><li><b>'
						   + syntacticDiffs
						   + '%</b> round-tripped without semantic differences, and </li><li><b>'
						   + perfects
						   + '%</b> round-tripped with no character differences at all.</li></ul></p>' );
				var width = 800;
				res.write( '<table><tr height=60px>');
				res.write( '<td width=' +
						(width * perfects / 100 || 0) +
						'px style="background:green" title="Perfect / no diffs"></td>' );
				res.write( '<td width=' +
						(width * (syntacticDiffs - perfects) / 100 || 0) +
						'px style="background:yellow" title="Syntactic diffs"></td>' );
				res.write( '<td width=' +
						(width * (100 - syntacticDiffs) / 100 || 0) +
						'px style="background:red" title="Semantic diffs"></td>' );
				res.write( '</tr></table>' );

				res.write( '<p><a href="/topfails/0">See the individual results by title</a></p>' );

				res.end( '</body></html>' );
			}
		} );
	} );
},

failsWebInterface = function ( req, res ) {
	db.serialize( function () {
		var page = ( req.params[0] || 0 ) - 0,
			offset = page * 40;

		db.all( 'SELECT title, skips, fails, errors FROM pages WHERE result IS NOT NULL ORDER BY errors DESC, fails DESC, skips DESC LIMIT 40 OFFSET ?', [ offset ], function ( err, rows ) {
			var i, row, output, matches, total = {};

			if ( err ) {
				res.send( err.toString(), 500 );
			} else if ( rows.length <= 0 ) {
				res.send( 'No entries found', 404 );
			} else {
				res.setHeader( 'Content-Type', 'text/html' );
				res.status( 200 );
				res.write( '<html><body>' );

				res.write( '<p>' );
				if ( page > 0 ) {
					res.write( '<a href="/topfails/' + ( page - 1 ) + '">Previous</a> | ' );
				} else {
					res.write( 'Previous | ' );
				}
				res.write( '<a href="/topfails/' + ( page + 1 ) + '">Next</a>' );
				res.write( '</p>' );

				res.write( '<table><tr><th>Title</th><th>Syntactic diffs</th><th>Semantic diffs</th><th>Errors</th></tr>' );

				for ( i = 0; i < rows.length; i++ ) {
					res.write( '<tr><td style="color: ' );
					row = rows[i];

					if ( row.skips === 0 && row.fails === 0 && row.errors === 0 ) {
						res.write( 'green' );
					} else if ( row.errors > 0 ) {
						res.write( 'red' );
					} else if ( row.fails === 0 ) {
						res.write( 'orange' );
					} else {
						res.write( 'red' );
					}

					res.write( '">' + row.title + '</td>' );
					res.write( '<td>' + row.skips + '</td><td>' + row.fails + '</td><td>' + ( row.errors === null ? 0 : row.errors ) + '</td></tr>' );
				}
				res.end( '</table></body></html>' );
			}
		} );
	} );
},

resultsWebInterface = function ( req, res ) {
	var hasStarted = false;

	db.all( 'SELECT result FROM pages WHERE result IS NOT NULL', function ( err, rows ) {
		var i;
		if ( err ) {
			console.log( err );
			res.send( err.toString(), 500 );
		} else {
			if ( rows.length === 0 ) {
				res.send( '', 404 );
			} else {
				res.setHeader( 'Content-Type', 'text/xml; charset=UTF-8' );
				res.status( 200 );
				res.write( '<testsuite>' );

				for ( i = 0; i < rows.length; i++ ) {
					res.write( rows[i].result );
				}

				res.end( '</testsuite>' );
			}
		}
	} );
},


// Make an app
app = express.createServer();

// Make the coordinator app
coordApp = express.createServer();

// Add in the bodyParser middleware (because it's pretty standard)
app.use( express.bodyParser() );
coordApp.use( express.bodyParser() );

// Main interface
app.get( /^\/results$/, resultsWebInterface );

// List of failures sorted by severity
app.get( /^\/topfails\/(\d+)$/, failsWebInterface );
// 0th page
app.get( /^\/topfails$/, failsWebInterface );

// Overview of stats
app.get( /^\/stats$/, statsWebInterface );

// Clients will GET this path if they want to run a test
coordApp.get( /^\/title$/, getTitle );

// Recieve results from clients
coordApp.post( /^\/result\/([^\/]+)\/([^\/]+)/, recieveResults );

db.serialize( function () {
	db.run( 'CREATE TABLE IF NOT EXISTS pages ( title TEXT DEFAULT "", result TEXT DEFAULT NULL, claimed INTEGER DEFAULT NULL, client TEXT DEFAULT NULL , fails INTEGER DEFAULT NULL, skips INTEGER DEFAULT NULL, errors INTEGER DEFAULT NULL );', function ( err )  {
		if ( err ) {
			console.log( dberr || err );
		} else {
			app.listen( 8001 );
			coordApp.listen( 8002 );
		}
	} );
} );

}() );
